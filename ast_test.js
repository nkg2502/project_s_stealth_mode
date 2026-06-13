const fs = require('fs');
const path = require('path');
const { Parser, Language } = require('web-tree-sitter');

(async () => {
  await Parser.init();
  const parser = new Parser();
  const Lang = await Language.load(path.join(__dirname, 'node_modules/tree-sitter-c/tree-sitter-c.wasm'));
  parser.setLanguage(Lang);

  const code = `
struct ComplexData {
    int id;
    union {
        struct {
            int x;
            int y;
        } point;
    } coords;
};
struct {
    int global_a;
} global_struct;
  `;
  const tree = parser.parse(code);
  console.log(tree.rootNode.toString());
})();
