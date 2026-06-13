import type { Node, Tree } from 'web-tree-sitter';
import type { CallRow, Lang, LocalRow, RefRow, SymbolKind, SymbolRow, TypedefAlias } from '../core/types';
import { roleForNodeType } from '../core/refRole';
import { aggregateTagFromTypeText, anonAggregateTag, callRootMarker, castRootMarker, isSyntheticTag, parseRootMarker } from '../core/objChain';
import { buildFuncRanges, enclosingFuncAt } from './enclosingFunc';

// Extract symbols / references / call edges from a tree-sitter syntax tree via
// a single recursive walk. Comments are skipped entirely (their identifiers are
// never indexed); an "enclosing function" stack lets every call/reference record
// the function it sits inside (this is what powers the "Called by" relation).

export interface ExtractResult {
  symbols: SymbolRow[];
  refs: RefRow[];
  calls: CallRow[];
  locals: LocalRow[];
  aliases: TypedefAlias[];
  /** Fraction of bytes covered by top-level ERROR nodes (drives grep fallback). */
  errorRatio: number;
}

const IDENTIFIER_TYPES = new Set([
  'identifier',
  'field_identifier',
  'type_identifier',
  'statement_identifier',
  'namespace_identifier',
]);

/**
 * Tolerant parse-error check across web-tree-sitter node shapes. In 0.25+ a
 * node's `hasError` is a boolean *property*; older/foreign shapes only expose a
 * `type === 'ERROR'`. The live walk uses `node.isError` per-node for the error
 * ratio; this helper is the same predicate for callers holding a plain node.
 */
export function nodeHasParseErrors(
  node: { type?: string; hasError?: boolean } | null | undefined,
): boolean {
  if (!node) {
    return false;
  }
  if (typeof node.hasError === 'boolean') {
    return node.hasError;
  }
  return node.type === 'ERROR';
}

export function extractFromTree(tree: Tree, file: string, _lang: Lang): ExtractResult {
  const symbols: SymbolRow[] = [];
  const refs: RefRow[] = [];
  const calls: CallRow[] = [];
  const locals: LocalRow[] = [];
  const aliases: TypedefAlias[] = [];
  let errorBytes = 0;

  const funcStack: string[] = [];
  const enclosing = (): string | null =>
    funcStack.length ? funcStack[funcStack.length - 1] : null;

  // Enclosing aggregate (struct/union/class) tag stack — so a field knows which
  // aggregate owns it. Anonymous aggregates push '' (no owner) unless they are the
  // type of a `typedef`, in which case they take the typedef name.
  const aggStack: string[] = [];
  const owningAgg = (): string => (aggStack.length ? aggStack[aggStack.length - 1] : '');

  // Field *use* refs (`obj->head`) whose owner is the object's type, resolved after
  // the walk once every local/field is known: refIndex into `refs`, the object name
  // chain root-first, and the enclosing function (scope for the root lookup).
  const fieldUses: { refIndex: number; chain: string[]; func: string | null }[] = [];

  const mkSym = (
    name: string,
    kind: SymbolKind,
    node: Node,
    isDefinition: boolean,
    extra: SymExtra = {},
  ): void => {
    symbols.push({
      name,
      kind,
      file,
      line: node.startPosition.row,
      col: node.startPosition.column,
      endLine: node.endPosition.row,
      endCol: node.endPosition.column,
      isDefinition,
      source: 'ts',
      scope: extra.scope || undefined,
      dataType: extra.dataType || undefined,
      declType: extra.declType || undefined,
      signature: extra.signature || undefined,
      returnType: extra.returnType || undefined,
      storage: extra.storage || undefined,
      arity: extra.arity,
      paramTypes: extra.paramTypes || undefined,
    });
  };

  const mkLocal = (
    name: string,
    kind: 'local_variable' | 'parameter',
    node: Node,
    func: string,
    dataType?: string,
    declType?: string,
  ): void => {
    locals.push({
      name,
      kind,
      file,
      func,
      line: node.startPosition.row,
      col: node.startPosition.column,
      endLine: node.endPosition.row,
      endCol: node.endPosition.column,
      dataType: dataType || undefined,
      declType: declType || undefined,
    });
  };

  const visit = (node: Node): void => {
    const type = node.type;

    // Never descend into comments — identifiers inside them are not indexed.
    if (type === 'comment') {
      return;
    }

    if (node.isError) {
      const parent = node.parent;
      if (!parent || !parent.isError) {
        errorBytes += node.endIndex - node.startIndex;
      }
    }

    let pushedFunc = false;
    let pushedAgg = false;

    switch (type) {
      case 'function_definition': {
        const nameNode = funcDefName(node);
        if (nameNode) {
          const declarator = node.childForFieldName('declarator');
          const params = functionParams(declarator);
          mkSym(nameNode.text, 'function', nameNode, true, {
            signature: functionSignature(declarator),
            returnType: declaredTypeText(node),
            storage: storageText(node),
            arity: params?.arity,
            paramTypes: params?.paramTypes,
          });
          funcStack.push(nameNode.text);
          pushedFunc = true;
        }
        break;
      }
      case 'declaration': {
        handleDeclaration(node, mkSym, mkLocal, enclosing(), file);
        break;
      }
      case 'field_declaration': {
        // struct/union member(s) — globally addressable, e.g. jump to a field
        // declaration from `obj->field`. Tagged with the owning aggregate so the
        // jump can be narrowed to the field of the object's actual type.
        const owner = owningAgg();
        // The field's own declared aggregate type (e.g. `struct Inner_s rtf` →
        // Inner_s) so member-access resolution can walk `outer->rtf.x` hop by hop.
        const fieldType = declaredAggregateTag(node, file);
        const fieldDeclText = displayTypeText(node);
        for (const nm of fieldMemberNames(node)) {
          mkSym(nm.text, 'field', nm, true, { scope: owner, dataType: fieldType, declType: fieldDeclText });
        }
        break;
      }
      case 'parameter_declaration': {
        const fn = enclosing();
        if (fn) {
          const nm = declaratorName(node.childForFieldName('declarator'));
          if (nm) {
            mkLocal(nm.text, 'parameter', nm, fn, declaredAggregateTag(node, file), displayTypeText(node));
          }
        }
        break;
      }
      case 'alias_declaration': {
        // C++11 `using Alias = Type;` — index Alias as a typedef (name only).
        const nm = node.childForFieldName('name');
        if (nm) {
          mkSym(nm.text, 'typedef', nm, true);
        }
        break;
      }
      case 'type_definition': {
        // `typedef <named aggregate> Alias;` records Alias -> tag so a member
        // access through an object typed `Alias` resolves to the tag's fields.
        // `typedef <type_identifier> Alias;` (e.g. `typedef A_t A2_t;`) records
        // Alias -> the other type name, so a *chain* of typedefs (A2_t -> A_t ->
        // A_s) is followed transitively at resolution time. We can't tell here
        // whether the target is an aggregate alias or a scalar one (it may be
        // defined in another file), so record both; a scalar target simply never
        // matches a field's owning tag (harmless).
        const aliasTarget = typedefTargetName(node.childForFieldName('type'), file);
        for (const nm of typedefAliasNames(node)) {
          // `typedefAliasNames` so `typedef struct {…} PACKED Name;` records `Name`,
          // never the leading attribute-macro `PACKED`.
          mkSym(nm.text, 'typedef', nm, true);
          if (aliasTarget && aliasTarget !== nm.text) {
            aliases.push({ name: nm.text, target: aliasTarget });
          }
        }
        break;
      }
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier': {
        const nameNode = node.childForFieldName('name');
        const hasBody = node.childForFieldName('body') !== null;
        // Track the enclosing aggregate so member fields know their owner.
        // enum bodies hold enumerators (not fields), so only struct/union push.
        if (hasBody && type !== 'enum_specifier') {
          aggStack.push(aggMemberOwnerTag(node, file, owningAgg()));
          pushedAgg = true;
        }
        if (nameNode) {
          const kind: SymbolKind =
            type === 'struct_specifier'
              ? 'struct'
              : type === 'union_specifier'
                ? 'union'
                : 'enum';
          if (hasBody) {
            // Full definition with a body: `struct X { ... }`
            mkSym(nameNode.text, kind, nameNode, true);
          } else {
            // No body — distinguish forward declaration from type usage.
            // A forward declaration is a standalone `struct X;`: either the
            // struct_specifier sits directly at file/block scope (tree-sitter
            // parses a bare `struct X;` as a struct_specifier under
            // translation_unit), or its parent declaration/type_definition has
            // no declarator of its own. Everything else is a type-usage like
            // `struct X *p;` where the tag is already a `type_identifier` ref and
            // must NOT be duplicated in the symbols table.
            const parent = node.parent;
            const pType = parent?.type;
            const isForwardDecl =
              pType === 'translation_unit' ||
              pType === 'declaration_list' ||
              pType === 'linkage_specification' ||
              (parent != null &&
                (pType === 'declaration' || pType === 'type_definition') &&
                childrenForField(parent, 'declarator').length === 0);
            if (isForwardDecl) {
              mkSym(nameNode.text, kind, nameNode, false); // declaration, not definition
            }
            // else: type-usage (e.g. `struct X *p`) → skip symbol, refs already cover it
          }
        }
        break;
      }
      case 'enumerator': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          mkSym(nameNode.text, 'enumerator', nameNode, true);
        }
        break;
      }
      case 'preproc_def':
      case 'preproc_function_def': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          mkSym(nameNode.text, 'macro', nameNode, true);
        }
        break;
      }
      case 'labeled_statement': {
        const label = node.childForFieldName('label');
        if (label) {
          mkSym(label.text, 'label', label, true);
        }
        break;
      }
      // ---- C++ ----
      case 'class_specifier': {
        const nameNode = node.childForFieldName('name');
        if (node.childForFieldName('body') !== null) {
          aggStack.push(aggMemberOwnerTag(node, file, owningAgg()));
          pushedAgg = true;
        }
        if (nameNode) {
          mkSym(nameNode.text, 'class', nameNode, true);
        }
        break;
      }
      case 'namespace_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          mkSym(nameNode.text, 'namespace', nameNode, true);
        }
        break;
      }
      // ---- relations ----
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        const callee = calleeName(fn);
        if (callee) {
          calls.push({
            caller: enclosing(),
            callee: callee.text,
            file,
            line: callee.startPosition.row,
            col: callee.startPosition.column,
            source: 'ts',
          });
        }
        break;
      }
      default:
        break;
    }

    if (IDENTIFIER_TYPES.has(type)) {
      // For a `field` occurrence, record the aggregate that owns the field being
      // referenced so its references can be narrowed to one struct. A declaration
      // (`int head;`) is owned by the enclosing aggregate (known now); a use
      // (`obj->head`) is owned by the object's type — captured here as the object
      // chain and resolved after the walk (once all locals/fields are known).
      let owner = '';
      if (type === 'field_identifier') {
        const p = node.parent;
        if (p?.type === 'field_expression') {
          // A field_identifier under a field_expression is always its `field` (the
          // argument is an expression, never a bare field_identifier) — its owner is
          // the type of the object, resolved after the walk.
          fieldUses.push({ refIndex: refs.length, chain: astObjectChain(p.childForFieldName('argument'), owningAgg(), file), func: enclosing() });
        } else if (p?.type === 'field_designator') {
          // A DESIGNATED initializer (`struct T x = { .f = … }`): the owner is the
          // aggregate being initialized (C's "current object"), recovered from the
          // enclosing declaration/compound-literal type. Empty chain → a positional
          // (non-designator) shape we don't model → owner stays best-effort.
          const chain = designatorObjectChain(node, file);
          if (chain.length) {
            fieldUses.push({ refIndex: refs.length, chain, func: enclosing() });
          }
        } else if (isFieldDeclarationName(node)) {
          // A field *declaration* — owned by the enclosing aggregate. The name may be
          // nested in pointer/array/function declarators (`void (*cb)(int)`, `int
          // buf[8]`, `int *p`), so we walk up through declarator wrappers, not just
          // the direct parent.
          owner = owningAgg();
        }
      }
      refs.push({
        name: node.text,
        file,
        line: node.startPosition.row,
        col: node.startPosition.column,
        enclosingFunc: enclosing(),
        isLocal: false, // resolved after the walk, once all locals are known
        // Structural role straight from the node type — `identifier` is a value,
        // `type_identifier` a type, `field_identifier` a member, etc. Drives
        // definition routing (see refRole.ts) so a value never resolves to a tag.
        role: roleForNodeType(type),
        owner,
        source: 'ts',
      });
    }

    for (const child of node.namedChildren) {
      if (child) {
        visit(child);
      }
    }

    if (pushedFunc) {
      funcStack.pop();
    }
    if (pushedAgg) {
      aggStack.pop();
    }
  };

  const root = tree.rootNode;
  visit(root);

  // Recover the enclosing function for calls/refs the walk left at file scope. A
  // computed-goto / heavy-macro body (e.g. the eBPF interpreter `___bpf_prog_run`)
  // can make tree-sitter close the `function_definition` node early and re-sync the
  // body's tail as top-level statements, so calls/refs there carry a null
  // caller/enclosingFunc and surface under "(file scope)". The function's brace
  // boundary in the raw text is reliable where the AST node's end isn't: re-attribute
  // those rows to the function whose braces textually enclose them. Only fills nulls
  // (an AST-resolved caller is always kept) and runs before the is_local pass so a
  // recovered ref to a parameter still binds as a local.
  if (calls.some((c) => c.caller === null) || refs.some((r) => r.enclosingFunc === null)) {
    const anchors = symbols
      .filter((s) => s.kind === 'function' && s.isDefinition)
      .map((s) => ({ name: s.name, line: s.line, col: s.col }));
    const ranges = buildFuncRanges(root.text, anchors);
    if (ranges.length) {
      for (const c of calls) {
        if (c.caller === null) {
          const fn = enclosingFuncAt(ranges, c.line);
          if (fn) {
            c.caller = fn;
          }
        }
      }
      for (const r of refs) {
        if (r.enclosingFunc === null) {
          const fn = enclosingFuncAt(ranges, r.line);
          if (fn) {
            r.enclosingFunc = fn;
          }
        }
      }
    }
  }

  // Classify each reference: an occurrence whose name is a parameter/local of
  // its enclosing function binds to that local (not a same-named global). Only a
  // `value` token can bind to a local — a type tag / field / label of the same
  // name must not (that is exactly the role distinction).
  const localKeys = new Set(locals.map((l) => `${l.func} ${l.name}`));
  if (localKeys.size) {
    for (const r of refs) {
      if (r.role === 'value' && r.enclosingFunc && localKeys.has(`${r.enclosingFunc} ${r.name}`)) {
        r.isLocal = true;
      }
    }
  }

  // Resolve the owner of each field *use* (`obj->head`) from its object chain: the
  // root's type (a local/param/global `dataType`), then each hop's field type — all
  // same-file. The owner of the referenced field is the type of its immediate
  // object. Unresolvable hops (cross-file types) leave the owner `''` (kept by every
  // query — best-effort, never hides a valid reference).
  if (fieldUses.length) {
    resolveFieldUseOwners(fieldUses, refs, symbols, locals, aliases);
  }

  const total = Math.max(1, root.endIndex - root.startIndex);
  return { symbols, refs, calls, locals, aliases, errorRatio: Math.min(1, errorBytes / total) };
}

// ---- helpers ----

/**
 * The object-name chain (root first) of a member-access base expression:
 * `node` → `['node']`, `node->head` → `['node','head']`, `(*p)` / `arr[i]` peel the
 * operator. Three bases state (or imply) the root type without a name, so their root
 * becomes a sigil marker (see core/objChain.ts) the owner resolvers understand:
 * a cast `((struct X *)p)->f` → `@type:X`, a call `get_obj()->f` → `@call:get_obj`,
 * and `this->f` → `@type:<enclosing aggregate>` (`encAgg`, threaded in from the walk).
 * Returns `[]` for a base we still can't reduce (an untagged cast type, a call with
 * no plain callee, `this` outside a known aggregate, an unhandled shape), leaving the
 * owner unresolved.
 */
function astObjectChain(node: Node | null, encAgg: string, file: string): string[] {
  if (!node) {
    return [];
  }
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
      return [node.text];
    case 'this':
      // `this->f` / `(*this).f` — the object's type is the enclosing class/struct,
      // known structurally at index time. Empty outside an aggregate (out-of-line
      // method `void C::m(){ this->f; }`) → unresolved, kept best-effort.
      return encAgg ? [castRootMarker(encAgg)] : [];
    case 'field_expression': {
      const base = astObjectChain(node.childForFieldName('argument'), encAgg, file);
      const field = node.childForFieldName('field');
      return base.length && field ? [...base, field.text] : [];
    }
    case 'cast_expression': {
      // `(struct X *)p` — the cast type is the root's type, stated outright. The
      // type_descriptor's `type` field is the specifier we tag (primitive → []).
      const tag = aggregateTagFromType(node.childForFieldName('type')?.childForFieldName('type') ?? null, file);
      return tag ? [castRootMarker(tag)] : [];
    }
    case 'call_expression': {
      // `get_obj()` — the root's type is the callee's return type, resolved (maybe
      // cross-file) at owner-resolution time, so store the callee name as a marker.
      const callee = calleeName(node.childForFieldName('function'));
      return callee ? [callRootMarker(callee.text)] : [];
    }
    case 'pointer_expression':
    case 'parenthesized_expression':
      return astObjectChain(node.childForFieldName('argument') ?? node.namedChildren.find((n): n is Node => n != null) ?? null, encAgg, file);
    case 'subscript_expression':
      return astObjectChain(node.childForFieldName('argument'), encAgg, file);
    default:
      return [];
  }
}

/** The `field_identifier` text of a `field_designator` (`.f`), if any. */
function fieldDesignatorName(desig: Node): string | undefined {
  const id = desig.namedChildren.find((n): n is Node => n?.type === 'field_identifier');
  return id?.text;
}

/**
 * Object chain (root-first) for a DESIGNATED-INITIALIZER field — `.f` / `.a.b` /
 * `{ .inner = { .f } }` — so its owner resolves to the aggregate being initialized
 * (C's "current object", §6.7.9). The chain root is an `@type:<T>` marker for the
 * declared / compound-literal type whose initializer encloses the field, followed
 * by the field names of any designators that PRECEDE this one on the path. This is
 * the deterministic subset: every step is a designator (`initializer_pair`) link.
 * POSITIONAL/implicit advancement (a bare `{…}` element with no designator) is not
 * modeled — it needs member-ordering state — so such a field returns `[]` (owner
 * stays best-effort, exactly as before).
 */
function designatorObjectChain(fid: Node, file: string): string[] {
  const desig = fid.parent; // field_designator
  const pair = desig?.parent; // initializer_pair
  if (!desig || !pair || pair.type !== 'initializer_pair') {
    return [];
  }
  const base = initListBaseChain(pair.parent, file);
  if (!base) {
    return [];
  }
  // Field names of the designators on this pair that come BEFORE `fid`'s designator
  // (`.a.b` → resolving `b` adds the hop `a`; a `[i]` subscript keeps the element
  // type, i.e. contributes no name hop). NB: web-tree-sitter returns fresh node
  // wrappers, so identity is by source span, not `===`.
  const hops: string[] = [];
  for (const d of childrenForField(pair, 'designator')) {
    if (d.startIndex === desig.startIndex && d.endIndex === desig.endIndex) {
      break;
    }
    if (d.type === 'field_designator') {
      const nm = fieldDesignatorName(d);
      if (!nm) {
        return [];
      }
      hops.push(nm);
    }
  }
  return [...base, ...hops];
}

/**
 * The object chain whose resolved type is the "current object" for the elements of
 * an `initializer_list` — its base aggregate type, root-first. Deterministic cases
 * only: the list is the value of a declarator (`struct T x = {…}` → `@type:T`), of a
 * compound literal (`(struct T){…}` → `@type:T`), or of an outer designated pair
 * (`{ .inner = {…} }` → base of the outer list ++ that pair's designator fields).
 * Returns undefined for a positional element (parent is another `initializer_list`)
 * or any shape we don't model — the caller then leaves the owner best-effort.
 */
function initListBaseChain(list: Node | null, file: string): string[] | undefined {
  if (!list || list.type !== 'initializer_list') {
    return undefined;
  }
  const parent = list.parent;
  if (!parent) {
    return undefined;
  }
  if (parent.type === 'init_declarator') {
    // value of a declarator → the declared aggregate type of the enclosing declaration
    const tag = parent.parent ? declaredAggregateTag(parent.parent, file) : undefined;
    return tag ? [castRootMarker(tag)] : undefined;
  }
  if (parent.type === 'compound_literal_expression') {
    const tag = aggregateTagFromType(parent.childForFieldName('type')?.childForFieldName('type') ?? null, file);
    return tag ? [castRootMarker(tag)] : undefined;
  }
  if (parent.type === 'initializer_pair') {
    // nested designated braces: base of the outer list, then this pair's designators
    const outer = initListBaseChain(parent.parent, file);
    if (!outer) {
      return undefined;
    }
    const hops: string[] = [];
    for (const d of childrenForField(parent, 'designator')) {
      if (d.type === 'field_designator') {
        const nm = fieldDesignatorName(d);
        if (!nm) {
          return undefined;
        }
        hops.push(nm);
      }
    }
    return [...outer, ...hops];
  }
  return undefined; // positional element / unmodeled → best-effort
}

/**
 * Fill in `refs[u.refIndex].owner` for each queued field use from its object chain,
 * using only this file's symbols/locals/aliases (best-effort, cross-file → `''`).
 * The owner of a field `a->b.head` is the type of `b`: start from the root object's
 * declared type, then walk each intermediate field to its own declared type.
 */
function resolveFieldUseOwners(
  fieldUses: { refIndex: number; chain: string[]; func: string | null }[],
  refs: RefRow[],
  symbols: SymbolRow[],
  locals: LocalRow[],
  aliases: TypedefAlias[],
): void {
  const aliasMap = new Map(aliases.map((a) => [a.name, a.target]));
  // The set of same-file tags equivalent to `t` (following typedef aliases here).
  const tagsFor = (t: string): Set<string> => {
    const out = new Set<string>();
    let cur: string | undefined = t;
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = aliasMap.get(cur);
    }
    return out;
  };
  // The return type tag of a same-file callee (function definition or prototype),
  // for a `@call:` chain root. A cross-file callee isn't in `symbols` → undefined
  // (the owner stays '' and query-time resolution re-derives it against the full DB).
  const callReturnType = (callee: string): string | undefined => {
    const fn = symbols.find(
      (s) => (s.kind === 'function' || s.kind === 'prototype') && s.name === callee && s.returnType,
    );
    return fn ? aggregateTagFromTypeText(fn.returnType) : undefined;
  };
  const rootType = (elem: string, func: string | null): string | undefined => {
    const marker = parseRootMarker(elem);
    if (marker) {
      // `@type:X` carries the tag outright; `@call:foo` → the callee's return type.
      return marker.kind === 'type' ? marker.value : callReturnType(marker.value);
    }
    const l = func ? locals.find((x) => x.func === func && x.name === elem && x.dataType) : undefined;
    if (l?.dataType) {
      return l.dataType;
    }
    return symbols.find((s) => s.kind === 'global_variable' && s.name === elem && s.dataType)?.dataType;
  };
  const fieldType = (fieldName: string, ownerType: string): string | undefined => {
    const tags = tagsFor(ownerType);
    return symbols.find((s) => s.kind === 'field' && s.name === fieldName && s.dataType && tags.has(s.scope ?? ''))?.dataType;
  };
  for (const u of fieldUses) {
    if (u.chain.length === 0) {
      continue;
    }
    // Persist the object chain so References can re-derive the owner cross-file at
    // query time when this same-file pass can't (e.g. a global typed in another file).
    refs[u.refIndex].objChain = u.chain.join(' ');
    let t = rootType(u.chain[0], u.func);
    for (let i = 1; t && i < u.chain.length; i++) {
      t = fieldType(u.chain[i], t);
    }
    if (t) {
      refs[u.refIndex].owner = t;
    }
  }
}

function childrenForField(node: Node, field: string): Node[] {
  return node.childrenForFieldName(field).filter((n): n is Node => n != null);
}

/**
 * Whether a `field_identifier` is the declared name of a `field_declaration` —
 * true even when nested in pointer/array/function/parenthesized declarators
 * (`void (*cb)(int)`, `int buf[8]`, `int *p`, `int (*fp[2])(void)`). Walks up only
 * through declarator wrappers; anything else (a use already handled separately, a
 * designated initializer, …) returns false.
 */
function isFieldDeclarationName(node: Node): boolean {
  const DECLARATOR_WRAPPERS = new Set([
    'pointer_declarator',
    'array_declarator',
    'function_declarator',
    'parenthesized_declarator',
  ]);
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === 'field_declaration') {
      return true;
    }
    if (!DECLARATOR_WRAPPERS.has(cur.type)) {
      return false;
    }
  }
  return false;
}

/** Unwrap pointer/array/parenthesized/init declarators to the inner name node. */
function declaratorName(n: Node | null): Node | null {
  if (!n) {
    return null;
  }
  switch (n.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
    case 'statement_identifier':
    case 'destructor_name':
    case 'operator_name':
    case 'primitive_type':
      // `typedef unsigned int uint32_t;` — tree-sitter classifies the trailing
      // typedef name as a primitive_type in the declarator field.
      return n;
    case 'qualified_identifier':
      return declaratorName(n.childForFieldName('name')) ?? lastIdentifier(n);
    case 'parenthesized_declarator':
      // `(*FuncPtr)` / `(CALLBACK *LPFN)` — function-pointer typedefs/vars. The
      // declared name is the LAST name node in the group (a leading
      // calling-convention macro reads as a type); type_identifier counts too
      // (a typedef name is a type_identifier, not an `identifier`).
      return lastNameNode(n);
    default: {
      const d = n.childForFieldName('declarator');
      if (d) {
        return declaratorName(d);
      }
      return lastIdentifier(n);
    }
  }
}

function lastIdentifier(n: Node): Node | null {
  const ids = n.descendantsOfType('identifier').filter((x): x is Node => x != null);
  return ids.length ? ids[ids.length - 1] : null;
}

const NAME_NODE_TYPES = new Set(['identifier', 'type_identifier', 'field_identifier', 'operator_name', 'destructor_name']);

/** The last identifier/type_identifier/field_identifier descendant of `n`. */
function lastNameNode(n: Node): Node | null {
  let last: Node | null = null;
  const walk = (x: Node): void => {
    if (NAME_NODE_TYPES.has(x.type)) {
      last = x;
    }
    for (const c of x.namedChildren) {
      if (c) {
        walk(c);
      }
    }
  };
  walk(n);
  return last;
}

function findFunctionDeclarator(n: Node | null): Node | null {
  if (!n) {
    return null;
  }
  if (n.type === 'function_declarator') {
    return n;
  }
  const d = n.childForFieldName('declarator');
  return d ? findFunctionDeclarator(d) : null;
}

/**
 * Whether a declarator declares a function-POINTER variable (`void (*fp)(int)`,
 * `int (*tbl[3])(void)`) rather than a function prototype. tree-sitter shapes the
 * two distinctly: a function pointer's `function_declarator` has its name nested in
 * a `parenthesized_declarator` (the `(*name)` group), whereas a real prototype's is
 * a bare identifier and a pointer-RETURNING prototype (`void *foo(int)`) wraps the
 * function_declarator in an outer `pointer_declarator` (so its function_declarator's
 * own declarator is still the identifier). Used to route a bare function-pointer
 * declaration to the variable branch instead of recording it as a prototype.
 */
function isFunctionPointerDeclarator(decl: Node): boolean {
  const fd = findFunctionDeclarator(decl);
  return fd?.childForFieldName('declarator')?.type === 'parenthesized_declarator';
}

function funcDefName(fnDef: Node): Node | null {
  const fnDecl = findFunctionDeclarator(fnDef.childForFieldName('declarator'));
  if (fnDecl) {
    // Recovery: a type specifier the C grammar doesn't model (a GNU `__complex__`,
    // a C99 `_Complex`, …) makes tree-sitter misread a trailing type keyword as the
    // function name and re-sync the REAL name into an ERROR node sitting just before
    // the parameter list (`<type> ERROR(<name>) (params)`). Prefer that name.
    const recovered = errorWrappedDeclaratorName(fnDecl);
    if (recovered) return recovered;

    const name = declaratorName(fnDecl.childForFieldName('declarator'));
    if (name) return name;
  }

  // ---- Fallback: Fuzzy search for broken ASTs due to macros ----
  
  // 1. Find the parameter list anchor
  const paramList = fnDef.children.find(
    (c) => c?.type === 'parameter_list' || c?.type === 'parenthesized_declarator'
  );

  if (paramList) {
    const idx = fnDef.children.indexOf(paramList);
    // Search backwards from the anchor for the first identifier
    for (let i = idx - 1; i >= 0; i--) {
      const c = fnDef.children[i];
      if (c && IDENTIFIER_TYPES.has(c.type)) {
        return c;
      }
    }
  }

  // 2. If no parameter list is found, fallback to the body anchor
  const body = fnDef.childForFieldName('body') || fnDef.children.find((c) => c?.type === 'compound_statement');
  if (body) {
    const bodyIdx = fnDef.children.indexOf(body);
    for (let i = bodyIdx - 1; i >= 0; i--) {
      const c = fnDef.children[i];
      if (c && IDENTIFIER_TYPES.has(c.type)) {
        return c;
      }
    }
  }

  return null;
}

/**
 * The real function name when an unrecognized type specifier pushed it into an ERROR
 * node immediately before the parameter list, or null for a normally-shaped declarator.
 * Only fires on the exact `… ERROR(identifier) parameter_list` misparse so well-formed
 * declarators (and function pointers, whose pre-params node is a parenthesized
 * declarator) keep their normal name.
 */
function errorWrappedDeclaratorName(fnDecl: Node): Node | null {
  // web-tree-sitter hands back a fresh wrapper on each access, so locate the
  // parameter list and its preceding sibling within a single `children` snapshot
  // rather than via indexOf (reference equality would fail).
  const kids = fnDecl.children;
  for (let i = 1; i < kids.length; i++) {
    if (kids[i]?.type === 'parameter_list') {
      const prev = kids[i - 1];
      return prev?.type === 'ERROR' ? lastIdentifier(prev) : null;
    }
  }
  return null;
}

function calleeName(fn: Node | null): Node | null {
  if (!fn) {
    return null;
  }
  if (fn.type === 'identifier' || fn.type === 'qualified_identifier') {
    return declaratorName(fn);
  }
  if (fn.type === 'field_expression') {
    return fn.childForFieldName('field');
  }
  return null;
}

/** Optional descriptor fields for a symbol (owner tag, declared type, function info). */
interface SymExtra {
  scope?: string;
  dataType?: string;
  declType?: string;
  signature?: string;
  returnType?: string;
  storage?: string;
  arity?: number;
  paramTypes?: string;
}
type MkSym = (name: string, kind: SymbolKind, node: Node, isDefinition: boolean, extra?: SymExtra) => void;
type MkLocal = (
  name: string,
  kind: 'local_variable' | 'parameter',
  node: Node,
  func: string,
  dataType?: string,
  declType?: string,
) => void;

/**
 * File-scope declarations become global symbols (prototypes / global variables).
 * Declarations inside a function body become scope-local `variable` rows tagged
 * with the enclosing function, so they resolve within that function only.
 */
function handleDeclaration(node: Node, mkSym: MkSym, mkLocal: MkLocal, func: string | null, file: string): void {
  const parentType = node.parent?.type;
  // A declaration_list is the body of an `extern "C" { … }` linkage block or a
  // namespace — declarations there are file-scope-equivalent (prototypes /
  // globals), not function-body locals (those live in a compound_statement).
  const fileScope =
    parentType === 'translation_unit' ||
    parentType === 'linkage_specification' ||
    parentType === 'declaration_list';
  for (const decl of childrenForField(node, 'declarator')) {
    // An init_declarator carries an initializer, so it always *defines* a
    // variable — even a function pointer like `int (*fp)(int) = 0;`, which would
    // otherwise be mistaken for a prototype by findFunctionDeclarator. A bare
    // function-POINTER declaration (`void (*fp)(int);`, no initializer) is likewise a
    // variable, not a prototype — `findFunctionDeclarator` only sees the outer call
    // signature. Both fall through to the variable branch below.
    const fnDecl =
      decl.type === 'init_declarator' || isFunctionPointerDeclarator(decl)
        ? null
        : findFunctionDeclarator(decl);
    if (fnDecl) {
      // function prototype — only meaningful at file scope
      if (fileScope) {
        const nm = declaratorName(fnDecl.childForFieldName('declarator'));
        if (nm) {
          const params = functionParams(fnDecl);
          mkSym(nm.text, 'prototype', nm, false, {
            signature: functionSignature(fnDecl),
            returnType: declaredTypeText(node),
            storage: storageText(node),
            arity: params?.arity,
            paramTypes: params?.paramTypes,
          });
        }
      }
      continue;
    }
    const nm = declaratorName(decl);
    if (!nm) {
      continue;
    }
    if (fileScope) {
      // `extern T x;` (no initializer) is a *declaration*, not a definition —
      // otherwise the Relations "Declaration" list misses it.
      const isDecl = hasExternStorage(node) && decl.type !== 'init_declarator';
      // Record the declared aggregate tag so a member access through a global
      // object (`gObj.field`) narrows to the field of its actual type, the same
      // way a local/parameter root does. Scalars/non-aggregates → undefined.
      mkSym(nm.text, 'global_variable', nm, !isDecl, {
        dataType: declaredAggregateTag(node, file),
        declType: displayTypeText(node),
        storage: storageText(node),
      });
    } else if (func) {
      mkLocal(nm.text, 'local_variable', nm, func, declaredAggregateTag(node, file), displayTypeText(node));
    }
  }
}

/**
 * The target a `typedef` points at, for the alias table: a named struct/union/
 * enum tag (`typedef struct A_s … A_t` → `A_s`), or another type name when the
 * underlying type is itself a (possibly typedef'd) named type (`typedef A_t A2_t`
 * → `A_t`) so transitive chains resolve. Anonymous/qualified/primitive → none.
 */
function typedefTargetName(typeNode: Node | null, file: string): string | undefined {
  // A typedef of an anonymous aggregate (`typedef struct {…} Foo;`) has NO named
  // target — its members are owned by the typedef name itself (the enclosing-aggregate
  // stack uses `typedefNameOfAnon`), so don't record an alias to the synthetic tag.
  const tag = aggregateTagName(typeNode, file);
  if (tag && !isSyntheticTag(tag)) {
    return tag;
  }
  return typeNode?.type === 'type_identifier' ? typeNode.text : undefined;
}

/** The aggregate tag named by a struct/union/enum specifier, if it has a name. */
function aggregateTagName(typeNode: Node | null, file: string): string | undefined {
  if (!typeNode) {
    return undefined;
  }
  if (
    typeNode.type === 'struct_specifier' ||
    typeNode.type === 'union_specifier' ||
    typeNode.type === 'enum_specifier'
  ) {
    const named = typeNode.childForFieldName('name')?.text;
    if (named) {
      return named;
    }
    // Anonymous aggregate WITH a body (`struct {…} x`) — a real type with members,
    // just no name. Give it the same synthetic, site-based tag the field owner gets
    // (`aggOwnerTag`) so the variable's element type and the field's owner agree. A
    // bodyless anonymous specifier can't occur (`struct;` is invalid) → undefined.
    return typeNode.childForFieldName('body') ? aggOwnerTag(typeNode, file) : undefined;
  }
  return undefined;
}

/**
 * The owning-aggregate tag of an aggregate definition node (struct/union/class):
 * its name, else the typedef name when it is the type of a `typedef`, else a
 * synthetic site-based tag for a truly anonymous aggregate (see core/objChain.ts).
 * Shared by the enclosing-aggregate stack (a field's owner) and `aggregateTagName`
 * (a variable's element type) so both name the same anonymous struct identically.
 */
function aggOwnerTag(node: Node, file: string): string {
  return (
    node.childForFieldName('name')?.text ||
    typedefNameOfAnon(node) ||
    anonAggregateTag(file, node.startPosition.row, node.startPosition.column)
  );
}

/**
 * The tag that should OWN the members of an aggregate definition `node` nested at
 * `owning`. Normally `aggOwnerTag(node)`, but an **anonymous struct/union that is a
 * nameless member** (`struct {…};` / `union {…};` with no member name) has its
 * members PROMOTED into the enclosing aggregate per C §6.7.2.1 — `s.x` reaches a
 * field `x` of an inner anonymous union directly. So its members must be owned by
 * the enclosing aggregate `owning`, not a distinct synthetic tag; otherwise a chain
 * walk (`s.x`, or `h2c.b_type_dma` where `b_type_dma` sits in an anonymous union of
 * `h2c_cmd`) can't find the member under `s`'s type and the owner is left unresolved
 * (which the reference filter then keeps best-effort, leaking into a foreign
 * same-named field). A *named* member (`struct {…} b_type_dma;`) is NOT promoted —
 * its members stay owned by its own (synthetic) tag, which is also the field's
 * declared `dataType`, so the next hop resolves.
 */
function aggMemberOwnerTag(node: Node, file: string, owning: string): string {
  return owning && isNamelessMember(node) ? owning : aggOwnerTag(node, file);
}

/**
 * Whether `node` is an anonymous struct/union/class declared as a nameless member
 * of an enclosing aggregate, whose members C promotes into that enclosing aggregate.
 * The nameless cases:
 *   - `struct {…};` — a `field_declaration` with no declarator.
 *   - `union {…} __packed;` — an attribute macro between `}` and `;` that tree-sitter
 *     mistakes for the member name, with NO real trailing name (`attrMacroRealName`).
 * A named tag, a genuinely named member (`struct {…} foo;`), or an attribute-macro'd
 * NAMED member (`struct {…} __packed foo;`, which has a recovered real name) is not.
 */
function isNamelessMember(node: Node): boolean {
  if (node.childForFieldName('name')) {
    return false; // a named tag is not anonymous
  }
  const p = node.parent;
  if (p?.type !== 'field_declaration') {
    return false;
  }
  const decls = childrenForField(p, 'declarator');
  if (decls.length === 0) {
    return true; // `struct {…};`
  }
  if (decls.length === 1) {
    const nm = declaratorName(decls[0]);
    // `union {…} __packed;` — a spurious attribute macro and no real name.
    return !!nm && isAttributeMacroName(nm.text) && !attrMacroRealName(p);
  }
  return false;
}

/**
 * The declared member name node(s) of a `field_declaration`, with attribute-macro
 * recovery. A GNU/kernel attribute macro between `}` and the member name
 * (`struct {…} __packed b_type_dma;`) defeats tree-sitter: it takes the macro
 * (`__packed`) as this field's name and re-parses the real name (`b_type_dma`) as a
 * following declarator-less `type_identifier` field. We recover the real name; when
 * there is no trailing name (`union {…} __packed;`) the macro is dropped and the
 * aggregate is treated as anonymous (its members promoted — see `isNamelessMember`).
 */
function fieldMemberNames(node: Node): Node[] {
  const names = childrenForField(node, 'declarator')
    .map((d) => declaratorName(d))
    .filter((n): n is Node => n != null);
  // The misparse only arises after a `}` — i.e. when this field's type is an
  // aggregate specifier WITH A BODY (`struct {…} __packed name;`). Gating on that
  // keeps a normal field whose name merely looks attribute-ish (`unsigned long
  // __reserved;`, `int PACKED;`) untouched.
  const agg = aggregateBodyType(node);
  if (agg && names.length === 1 && isAttributeMacroName(names[0].text)) {
    const real = attrMacroRealName(node);
    if (real) {
      return [real]; // `struct {…} __packed name;` — recover the real name
    }
    if (!agg.childForFieldName('name')) {
      return []; // anonymous `union {…} __packed;` — drop the spurious attribute
    }
  }
  return names;
}

const AGGREGATE_SPECIFIERS: ReadonlySet<string> = new Set([
  'struct_specifier', 'union_specifier', 'class_specifier',
]);

/** The struct/union/class specifier WITH A BODY that types `fieldDecl`, else null. */
function aggregateBodyType(fieldDecl: Node): Node | null {
  const t = fieldDecl.childForFieldName('type');
  return t && AGGREGATE_SPECIFIERS.has(t.type) && t.childForFieldName('body') ? t : null;
}

/**
 * The real member name re-parsed as a trailing declarator-less `type_identifier`
 * `field_declaration` after an attribute macro (`} __packed b_type_dma;` → the
 * `b_type_dma` sibling), else null. A bare `Type;` member is invalid C, so this
 * sibling shape is itself the misparse signature — never a real field.
 */
function attrMacroRealName(fieldDecl: Node): Node | null {
  const sib = fieldDecl.nextNamedSibling;
  if (sib?.type === 'field_declaration' && childrenForField(sib, 'declarator').length === 0) {
    const t = sib.childForFieldName('type');
    if (t?.type === 'type_identifier') {
      return t;
    }
  }
  return null;
}

/**
 * Whether a member "name" tree-sitter produced is really a GNU/kernel attribute
 * macro that sits between `}` and the member name (`__packed`, `__aligned`,
 * `__rcu`, `____cacheline_aligned`, `PACKED`, `ALIGNED`). A genuine struct member
 * is virtually never spelled this way — a leading `__` is reserved to the
 * implementation, and an all-caps identifier is by convention a macro/attribute.
 */
function isAttributeMacroName(text: string): boolean {
  return /^__[a-z]/.test(text) || /^_*[A-Z][A-Z0-9_]*$/.test(text);
}

/**
 * Best-effort declared aggregate tag of a declaration / parameter, for member
 * narrowing: an elaborated `struct rcu_state *p` → `rcu_state`, a typedef'd
 * `rcu_state_t *p` → `rcu_state_t`, a C++ qualified `MyNS::Config *cfg` → `Config`,
 * a template `std::vector<int> v` → `vector`. Non-aggregate (primitive) types →
 * undefined. The captured tag is the *rightmost* type component, which is what
 * matches a field's owning-aggregate `scope` (the namespace is dropped).
 */
function declaredAggregateTag(node: Node, file: string): string | undefined {
  const t = node.childForFieldName('type');
  return t ? aggregateTagFromType(t, file) : undefined;
}

/**
 * The full declared type *text* of a declaration / parameter / field for display
 * in the Code Insight "Type" row (`uint32_t`, `struct rcu_state`, `MyNS::Config`).
 * The type-specifier node only (the declarator's `*`/`[]`/name are excluded);
 * whitespace is collapsed. Unlike `declaredAggregateTag` this keeps primitives and
 * the namespace. Empty when there is no type field.
 */
function declaredTypeText(node: Node): string | undefined {
  const t = node.childForFieldName('type');
  if (!t) {
    return undefined;
  }
  return t.text.replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * The declared type *text* for the Code Insight "Type" row, **function-pointer
 * aware**. For an ordinary declaration this is just the type specifier
 * (`declaredTypeText`). For a function-pointer declarator (`void (*data2)(int,
 * size_t)`) the bare specifier (`void`) is only the function's *return* type — a
 * misleading "Type" — so we compose the pointer-to-function type `void (*)(int,
 * size_t)` from the return specifier, the pointer stars, and the parameter list
 * (the declared name dropped), mirroring how a compiler reads the declarator
 * inside-out. Used for field / parameter / variable declTypes; NOT for a function
 * definition's return type or the per-parameter `paramTypes` list (those want the
 * bare specifier and must stay comma-free).
 */
function displayTypeText(node: Node): string | undefined {
  return fnPtrTypeText(node) ?? declaredTypeText(node);
}

/**
 * The pointer-to-function type text of a declaration whose declarator is a
 * function pointer (`<ret> (*name)(params)` → `<ret> (*)(params)`), else undefined.
 * Handles a leading `init_declarator` (`int (*fp)(int) = 0`) and nested pointers
 * (`(**name)` → `(**)`). Best-effort: an array-of-pointers / more exotic shape that
 * doesn't match this pattern simply returns undefined (the caller keeps the specifier).
 */
function fnPtrTypeText(node: Node): string | undefined {
  const ret = declaredTypeText(node);
  if (!ret) {
    return undefined;
  }
  for (const decl of childrenForField(node, 'declarator')) {
    const d: Node | null = decl.type === 'init_declarator' ? decl.childForFieldName('declarator') : decl;
    if (!d || d.type !== 'function_declarator') {
      continue;
    }
    const inner = d.childForFieldName('declarator');
    if (!inner || inner.type !== 'parenthesized_declarator') {
      continue;
    }
    const ptr = inner.namedChildren.find((c): c is Node => c?.type === 'pointer_declarator') ?? null;
    if (!ptr) {
      continue;
    }
    let stars = '';
    for (let cur: Node | null = ptr; cur && cur.type === 'pointer_declarator'; cur = cur.childForFieldName('declarator')) {
      stars += '*';
    }
    const params = d.childForFieldName('parameters')?.text.replace(/\s+/g, ' ').trim() ?? '()';
    return `${ret} (${stars})${params}`;
  }
  return undefined;
}

/**
 * Storage-class / function specifiers on a declaration/definition node (`static`,
 * `extern`, `inline`, `register`, `typedef`, `auto`) in source order, space-joined.
 * tree-sitter exposes each as a direct `storage_class_specifier` child (incl.
 * `inline`). Empty when none.
 */
function storageText(node: Node): string | undefined {
  const parts: string[] = [];
  for (const c of node.children) {
    if (c && c.type === 'storage_class_specifier') {
      parts.push(c.text);
    }
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * The signature of a function: its `function_declarator` text — `name(paramType
 * param, …)` — whitespace-collapsed. `declarator` may be the function_declarator
 * itself or wrap it (a `pointer_declarator` for a pointer-returning function), so
 * we descend with `findFunctionDeclarator`. Empty when there is no such declarator.
 */
function functionSignature(declarator: Node | null): string | undefined {
  const fnDecl = findFunctionDeclarator(declarator);
  if (!fnDecl) {
    return undefined;
  }
  return fnDecl.text.replace(/\s+/g, ' ').trim() || undefined;
}

/**
 * The fixed-parameter count and per-parameter type list of a function from its
 * `function_declarator`. `(void)` → arity 0; an unspecified `()` → arity `undefined`
 * (constrains nothing, so it is never used to exclude a candidate); a trailing `...`
 * marks variadic (kept in `paramTypes`, arity counts only the fixed params). Each
 * param type is the specifier text (a declarator's `*` is not folded in — coarse but
 * enough for arity / loose type narrowing; the full text lives in `signature`).
 */
function functionParams(declarator: Node | null): { arity?: number; paramTypes?: string } | undefined {
  const fnDecl = findFunctionDeclarator(declarator);
  const plist = fnDecl?.childForFieldName('parameters');
  if (!plist) {
    return undefined;
  }
  const kids = plist.namedChildren.filter((n): n is Node => n != null);
  const params = kids.filter((n) => n.type === 'parameter_declaration');
  const variadic = kids.some((n) => n.type === 'variadic_parameter');
  if (params.length === 0) {
    // `foo(...)` variadic-only is rare; an empty `()` is unspecified — leave arity
    // unconstrained so it never excludes a candidate.
    return variadic ? { arity: 0, paramTypes: '...' } : { arity: undefined, paramTypes: undefined };
  }
  if (
    params.length === 1 &&
    params[0].childForFieldName('type')?.text === 'void' &&
    !params[0].childForFieldName('declarator')
  ) {
    return { arity: 0, paramTypes: undefined };
  }
  const types = params.map((p) => declaredTypeText(p) ?? '');
  if (variadic) {
    types.push('...');
  }
  return { arity: params.length, paramTypes: types.join(',') };
}

/** The aggregate tag named by a type-specifier node (recurses through qualified/template). */
function aggregateTagFromType(t: Node | null, file: string): string | undefined {
  if (!t) {
    return undefined;
  }
  switch (t.type) {
    case 'struct_specifier':
    case 'union_specifier':
    case 'enum_specifier':
      return aggregateTagName(t, file);
    case 'type_identifier':
      return t.text;
    case 'template_type': {
      // `vector<int>` → `vector` — the template name is the aggregate.
      const name = t.childForFieldName('name');
      return name ? aggregateTagFromType(name, file) : undefined;
    }
    case 'qualified_identifier':
    case 'scoped_type_identifier': {
      // `MyNS::Config` / `A::B::C` → the rightmost component names the type;
      // recurse so `std::vector<int>` reaches the template name, `A::B::C` → C.
      const kids = t.namedChildren.filter((n): n is Node => n != null);
      const last = kids.length ? kids[kids.length - 1] : null;
      return last ? aggregateTagFromType(last, file) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The alias name node(s) a `typedef` introduces, repairing the two ways an
 * attribute-macro between the type and the name (`typedef struct {…} PACKED Name;`)
 * defeats tree-sitter:
 *   (a) normal — the names are the `declarator`-field children
 *       (`typedef int A, B;`, `typedef unsigned int uint32_t;`).
 *   (b) the macro is taken as the declarator and the real name lands in a trailing
 *       **ERROR** node inside the type_definition (the macro'd typedef in isolation).
 *   (c) the type_definition is cut off right after the macro and the real name is
 *       parsed as the *following* lone-identifier statement (the common case in a
 *       real header, where another statement follows).
 * In (b)/(c) the macro declarator is dropped in favour of the recovered name. A
 * genuine multi-alias `A, B;` has neither an ERROR sibling nor a trailing
 * lone-identifier statement, so it stays on path (a).
 */
function typedefAliasNames(td: Node): Node[] {
  const type = td.childForFieldName('type');
  const typeEnd = type ? type.endIndex : 0;

  // (b) a post-type ERROR node carrying the real name.
  for (const c of td.namedChildren) {
    if (c && c.type === 'ERROR' && c.startIndex >= typeEnd) {
      const nm = lastNameNode(c) ?? (/^[A-Za-z_]\w*$/.test(c.text) ? c : null);
      if (nm) {
        return [nm];
      }
    }
  }

  const decls = childrenForField(td, 'declarator')
    .map((d) => declaratorName(d))
    .filter((n): n is Node => n != null);

  // (c) cut-off typedef: a single bare type_identifier declarator (the macro)
  // immediately followed by a lone-identifier statement (the real name).
  if (decls.length === 1 && decls[0].type === 'type_identifier') {
    const stray = strayTypedefName(td);
    if (stray) {
      return [stray];
    }
  }
  return decls;
}

/**
 * The lone identifier of the statement immediately following a `type_definition`
 * — the real typedef name when an attribute-macro cut the typedef off early
 * (`typedef struct {…} PACKED Name;` → the parser ends the typedef at `PACKED` and
 * parses `Name;` as its own statement). A file-scope `identifier;` statement is
 * itself a parse artifact, so this is effectively never a false positive.
 */
function strayTypedefName(td: Node): Node | null {
  const sib = td.nextNamedSibling;
  if (!sib || sib.type !== 'expression_statement') {
    return null;
  }
  const kids = sib.namedChildren.filter((n): n is Node => n != null);
  return kids.length === 1 && kids[0].type === 'identifier' ? kids[0] : null;
}

/**
 * For an anonymous aggregate that is the type of a `typedef`, the typedef name —
 * so its members are still narrowable by the object's declared type even though
 * the aggregate itself has no tag (`typedef struct {…} Foo_t;`, `… PACKED Foo_t;`).
 */
function typedefNameOfAnon(aggNode: Node): string {
  const p = aggNode.parent;
  if (p && p.type === 'type_definition') {
    return typedefAliasNames(p)[0]?.text ?? '';
  }
  return '';
}

function hasExternStorage(node: Node): boolean {
  for (const c of node.children) {
    if (c && c.type === 'storage_class_specifier' && c.text === 'extern') {
      return true;
    }
  }
  return false;
}
