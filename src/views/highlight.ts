const KEYWORDS = new Set([

  "import", "from", "export", "default", "function", "const", "let", "var", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "class",
  "extends", "new", "this", "async", "await", "try", "catch", "finally", "throw",
  "typeof", "instanceof", "in", "of", "interface", "type", "enum", "implements",
  "public", "private", "protected", "readonly", "static", "void", "as", "yield",

  "fn", "pub", "use", "mod", "impl", "struct", "trait", "match", "mut", "ref", "where",
  "loop", "move", "crate", "super", "self", "Self", "unsafe", "dyn",

  "def", "elif", "lambda", "with", "pass", "raise", "global", "nonlocal", "and", "or",
  "not", "is", "except",

  "param", "foreach", "then", "fi", "esac",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "$true", "$false", "$null"]);

const TOKEN = new RegExp(
  [
    String.raw`(\/\/.*$|#(?![\[!]).*$)`,
    String.raw`("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|` + "`(?:[^`\\\\]|\\\\.)*`?)",
    String.raw`(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)`,
    String.raw`(\$?[A-Za-z_][\w]*)`,
  ].join("|"),
  "gim",
);

const HASH_COMMENTS = new Set(["py", "ps1", "psm1", "sh", "bash", "yml", "yaml", "toml", "rb", "r", "conf", "ini"]);

export function highlightLine(text: string, ext: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!text) {
    frag.append(document.createTextNode(" "));
    return frag;
  }
  const hashComments = HASH_COMMENTS.has(ext);
  let last = 0;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text))) {
    const [tok, comment, string, number, word] = m;
    let cls: string | null = null;
    if (comment) {
      if (comment.startsWith("#") && !hashComments) {
        TOKEN.lastIndex = m.index + 1;
        continue;
      }
      cls = "tk-com";
    } else if (string) cls = "tk-str";
    else if (number) cls = "tk-num";
    else if (word) {
      if (KEYWORDS.has(word)) cls = "tk-kw";
      else if (LITERALS.has(word)) cls = "tk-lit";
      else if (/^[A-Z]/.test(word)) cls = "tk-type";
      else if (text[m.index + word.length] === "(") cls = "tk-fn";
    }
    if (!cls) continue;
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = tok;
    frag.append(span);
    last = m.index + tok.length;
    if (tok.length === 0) TOKEN.lastIndex++;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

export function fileBadge(name: string): { label: string; color: string; ext: string } {
  const ext = (name.includes(".") ? name.split(".").pop() ?? "" : "").toLowerCase();
  const map: Record<string, [string, string]> = {
    ts: ["TS", "#3178C6"], tsx: ["TSX", "#3178C6"], js: ["JS", "#C9A400"], jsx: ["JSX", "#C9A400"],
    mjs: ["JS", "#C9A400"], json: ["{}", "#8E939C"], rs: ["RS", "#DE7A45"], py: ["PY", "#3B82C4"],
    md: ["MD", "#6B7079"], css: ["CSS", "#7C5CFF"], html: ["<>", "#E2583E"], ps1: ["PS", "#2F6FBA"],
    toml: ["TOML", "#9C6B4E"], yml: ["YML", "#CB4B4B"], yaml: ["YML", "#CB4B4B"], swift: ["SW", "#F05138"],
    go: ["GO", "#00ADD8"], java: ["JV", "#E76F00"], c: ["C", "#5C6BC0"], cpp: ["C++", "#5C6BC0"],
    cs: ["C#", "#68217A"], sh: ["SH", "#4E9A06"], sql: ["SQL", "#D97706"], txt: ["TXT", "#6B7079"],
  };
  const [label, color] = map[ext] ?? [ext ? ext.slice(0, 3).toUpperCase() : "·", "#5F646D"];
  return { label, color, ext };
}
