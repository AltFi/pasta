import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Monaco needs a web worker for tokenization/model services. We only edit
// Lua (a "basic" language with no dedicated language service worker), so
// the generic editor worker is the only one required.
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

// Apple-like dark palette, mapped onto Monaco's token scopes.
monaco.editor.defineTheme("pulse-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6c6c74", fontStyle: "italic" },
    { token: "keyword", foreground: "ff7ab2" },
    { token: "string", foreground: "ff8170" },
    { token: "number", foreground: "d19a66" },
    { token: "operator", foreground: "9a9aa2" },
    { token: "identifier", foreground: "eeeef0" },
    { token: "delimiter", foreground: "9a9aa2" },
    { token: "predefined", foreground: "66d9ef" },
  ],
  colors: {
    "editor.background": "#17171a",
    "editor.foreground": "#eeeef0",
    "editorLineNumber.foreground": "#4a4a52",
    "editorLineNumber.activeForeground": "#9a9aa2",
    "editor.selectionBackground": "#0a84ff33",
    "editor.inactiveSelectionBackground": "#0a84ff1a",
    "editor.lineHighlightBackground": "#ffffff08",
    "editorCursor.foreground": "#0a84ff",
    "editorWhitespace.foreground": "#2a2a30",
    "editorIndentGuide.background": "#242429",
    "editorIndentGuide.activeBackground": "#38383f",
    "scrollbarSlider.background": "#ffffff1a",
    "scrollbarSlider.hoverBackground": "#ffffff28",
    "editorWidget.background": "#1c1c20",
    "editorWidget.border": "#ffffff12",
    "editorSuggestWidget.background": "#1c1c20",
    "editorSuggestWidget.border": "#ffffff12",
    "editorSuggestWidget.selectedBackground": "#0a84ff26",
    "editorHoverWidget.background": "#1c1c20",
    "editorHoverWidget.border": "#ffffff12",
    "minimap.background": "#17171a",
  },
});

// Globals the runtime plans to expose (mirrors
// Environment::GetPlannedFunctionNames / GetPlannedGameObjectNames on the
// backend), plus a handful of common Roblox-executor conveniences, so
// autocomplete reflects what a script running under PulseExecutor can
// actually call.
const PLANNED_FUNCTIONS: Array<{ name: string; detail: string; snippet: string }> = [
  { name: "print", detail: "print(...) — write to the console", snippet: "print(${1:...})" },
  { name: "warn", detail: "warn(...) — write a warning to the console", snippet: "warn(${1:...})" },
  { name: "loadstring", detail: "loadstring(code) -> function", snippet: "loadstring(${1:code})" },
  { name: "assert", detail: "assert(condition, message?)", snippet: "assert(${1:condition}, ${2:\"message\"})" },
  { name: "tostring", detail: "tostring(value) -> string", snippet: "tostring(${1:value})" },
  { name: "tonumber", detail: "tonumber(value) -> number?", snippet: "tonumber(${1:value})" },
  { name: "type", detail: "type(value) -> string", snippet: "type(${1:value})" },
  { name: "pairs", detail: "pairs(table)", snippet: "pairs(${1:table})" },
  { name: "ipairs", detail: "ipairs(table)", snippet: "ipairs(${1:table})" },
  { name: "getfenv", detail: "getfenv(func?) -> table", snippet: "getfenv(${1:})" },
  { name: "setfenv", detail: "setfenv(func, table)", snippet: "setfenv(${1:func}, ${2:table})" },
  { name: "getmetatable", detail: "getmetatable(obj) -> table?", snippet: "getmetatable(${1:obj})" },
  { name: "setmetatable", detail: "setmetatable(obj, table)", snippet: "setmetatable(${1:obj}, ${2:table})" },
  { name: "rawget", detail: "rawget(table, key)", snippet: "rawget(${1:table}, ${2:key})" },
  { name: "rawset", detail: "rawset(table, key, value)", snippet: "rawset(${1:table}, ${2:key}, ${3:value})" },
  { name: "rawequal", detail: "rawequal(v1, v2) -> boolean", snippet: "rawequal(${1:v1}, ${2:v2})" },
];

const PLANNED_GLOBALS: Array<{ name: string; detail: string }> = [
  { name: "game", detail: "DataModel root" },
  { name: "workspace", detail: "game.Workspace" },
];

// Standard Lua 5.1 library functions — always available regardless of what
// PulseExecutor itself exposes, since they're part of the language runtime
// libraries, not custom globals.
const STDLIB_FUNCTIONS: Array<{ name: string; detail: string; snippet: string }> = [
  { name: "string.format", detail: "string.format(fmt, ...)", snippet: "string.format(${1:fmt}, ${2:...})" },
  { name: "string.sub", detail: "string.sub(s, i, j?)", snippet: "string.sub(${1:s}, ${2:i})" },
  { name: "string.find", detail: "string.find(s, pattern)", snippet: "string.find(${1:s}, ${2:pattern})" },
  { name: "string.gsub", detail: "string.gsub(s, pattern, repl)", snippet: "string.gsub(${1:s}, ${2:pattern}, ${3:repl})" },
  { name: "string.match", detail: "string.match(s, pattern)", snippet: "string.match(${1:s}, ${2:pattern})" },
  { name: "string.gmatch", detail: "string.gmatch(s, pattern)", snippet: "string.gmatch(${1:s}, ${2:pattern})" },
  { name: "string.rep", detail: "string.rep(s, n)", snippet: "string.rep(${1:s}, ${2:n})" },
  { name: "string.upper", detail: "string.upper(s)", snippet: "string.upper(${1:s})" },
  { name: "string.lower", detail: "string.lower(s)", snippet: "string.lower(${1:s})" },
  { name: "string.len", detail: "string.len(s)", snippet: "string.len(${1:s})" },
  { name: "string.byte", detail: "string.byte(s, i?)", snippet: "string.byte(${1:s})" },
  { name: "string.char", detail: "string.char(...)", snippet: "string.char(${1:...})" },
  { name: "table.insert", detail: "table.insert(t, value)", snippet: "table.insert(${1:t}, ${2:value})" },
  { name: "table.remove", detail: "table.remove(t, pos?)", snippet: "table.remove(${1:t})" },
  { name: "table.concat", detail: "table.concat(t, sep?)", snippet: "table.concat(${1:t})" },
  { name: "table.sort", detail: "table.sort(t, comp?)", snippet: "table.sort(${1:t})" },
  { name: "table.unpack", detail: "table.unpack(t) -> ...", snippet: "table.unpack(${1:t})" },
  { name: "table.getn", detail: "table.getn(t) -> number", snippet: "table.getn(${1:t})" },
  { name: "math.floor", detail: "math.floor(x)", snippet: "math.floor(${1:x})" },
  { name: "math.ceil", detail: "math.ceil(x)", snippet: "math.ceil(${1:x})" },
  { name: "math.random", detail: "math.random(m?, n?)", snippet: "math.random(${1:1}, ${2:100})" },
  { name: "math.min", detail: "math.min(...)", snippet: "math.min(${1:...})" },
  { name: "math.max", detail: "math.max(...)", snippet: "math.max(${1:...})" },
  { name: "math.abs", detail: "math.abs(x)", snippet: "math.abs(${1:x})" },
  { name: "math.huge", detail: "math.huge — infinity constant", snippet: "math.huge" },
  { name: "os.time", detail: "os.time() -> number", snippet: "os.time()" },
  { name: "os.clock", detail: "os.clock() -> number", snippet: "os.clock()" },
  { name: "os.date", detail: "os.date(fmt?) -> string", snippet: "os.date(${1:\"%c\"})" },
  { name: "coroutine.create", detail: "coroutine.create(f)", snippet: "coroutine.create(${1:f})" },
  { name: "coroutine.wrap", detail: "coroutine.wrap(f)", snippet: "coroutine.wrap(${1:f})" },
  { name: "coroutine.resume", detail: "coroutine.resume(co, ...)", snippet: "coroutine.resume(${1:co})" },
  { name: "coroutine.yield", detail: "coroutine.yield(...)", snippet: "coroutine.yield(${1:...})" },
  { name: "select", detail: "select(index, ...) or select('#', ...)", snippet: "select(${1:index}, ${2:...})" },
  { name: "unpack", detail: "unpack(t) -> ...", snippet: "unpack(${1:t})" },
  { name: "next", detail: "next(table, key?)", snippet: "next(${1:table})" },
  { name: "collectgarbage", detail: "collectgarbage(opt?)", snippet: "collectgarbage()" },
  { name: "xpcall", detail: "xpcall(f, handler, ...)", snippet: "xpcall(${1:f}, ${2:handler})" },
  { name: "pcall", detail: "pcall(f, ...) -> ok, result", snippet: "pcall(${1:f})" },
  { name: "error", detail: "error(message, level?)", snippet: "error(${1:message})" },
];

const SNIPPETS: Array<{ name: string; detail: string; snippet: string }> = [
  {
    name: "GetService",
    detail: "game:GetService(name)",
    snippet: 'game:GetService("${1:Players}")',
  },
  {
    name: "task.wait",
    detail: "task.wait(seconds?)",
    snippet: "task.wait(${1:1})",
  },
  {
    name: "task.spawn",
    detail: "task.spawn(function)",
    snippet: "task.spawn(function()\n\t${1}\nend)",
  },
  {
    name: "pcall-block",
    detail: "pcall(function() ... end)",
    snippet: "local ok, err = pcall(function()\n\t${1}\nend)\nif not ok then\n\twarn(err)\nend",
  },
  {
    name: "for-ipairs",
    detail: "for i, v in ipairs(t) do ... end",
    snippet: "for i, v in ipairs(${1:table}) do\n\t${2}\nend",
  },
];

export function registerLuaCompletions(): void {
  monaco.languages.registerCompletionItemProvider("lua", {
    triggerCharacters: [".", ":"],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monaco.languages.CompletionItem[] = [];

      for (const fn of PLANNED_FUNCTIONS) {
        suggestions.push({
          label: fn.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: fn.detail,
          insertText: fn.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      for (const fn of STDLIB_FUNCTIONS) {
        suggestions.push({
          label: fn.name,
          kind: monaco.languages.CompletionItemKind.Function,
          detail: fn.detail,
          insertText: fn.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      for (const g of PLANNED_GLOBALS) {
        suggestions.push({
          label: g.name,
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: g.detail,
          insertText: g.name,
          range,
        });
      }

      for (const s of SNIPPETS) {
        suggestions.push({
          label: s.name,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: s.detail,
          insertText: s.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
      }

      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider("lua", {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const fn = PLANNED_FUNCTIONS.find((f) => f.name === word.word) ?? STDLIB_FUNCTIONS.find((f) => f.name === word.word);
      if (fn) {
        return {
          contents: [{ value: `**${fn.name}**` }, { value: fn.detail }],
        };
      }

      const g = PLANNED_GLOBALS.find((g) => g.name === word.word);
      if (g) {
        return { contents: [{ value: `**${g.name}**` }, { value: g.detail }] };
      }

      return null;
    },
  });
}

export { monaco };
