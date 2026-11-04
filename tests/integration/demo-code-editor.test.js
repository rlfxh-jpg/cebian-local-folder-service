import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("CodeMirror 编辑、撤销、只读、语言切换和本地更新不会重复保存", async () => {
  const dom = new JSDOM("<!doctype html><div id='host'></div>", { pretendToBeVisual: true });
  const globals = ["window", "document", "navigator", "MutationObserver", "Window", "Node", "HTMLElement", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"];
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    const value = ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // jsdom provides a DOM, not a layout engine. Only editor behavior is tested here.
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  let editor;
  try {
    const { createCodeEditor } = await import("../../demo/src/editor/code-editor.js");
    const { undo, redo, insertNewlineAndIndent } = await import("@codemirror/commands");
    const { EditorState } = await import("@codemirror/state");
    const { language } = await import("@codemirror/language");
    const { openSearchPanel, closeSearchPanel } = await import("@codemirror/search");
    const changes = [];
    const compositions = [];
    let options = { value: "const n = 1;\n", path: "demo.ts", documentKey: "root:demo.ts", readOnly: false };
    editor = createCodeEditor({ parent: document.getElementById("host"), ...options,
      onChange: (value) => changes.push(value), onCompositionChange: (value) => compositions.push(value) });
    const { view } = editor;
    await editor.languageReady;
    assert.ok(view.state.facet(language), "TypeScript 文件应加载语言支持");
    assert.ok(document.querySelector(".cm-lineNumbers"), "显示 CodeMirror 行号");
    assert.equal(view.contentDOM.getAttribute("aria-label"), "文本文件内容");

    view.dispatch({ changes: { from: 10, to: 11, insert: "2" } });
    assert.deepEqual(changes, ["const n = 2;\n"], "用户编辑通知自动同步逻辑");
    options = { ...options, value: changes.at(-1) };
    editor.update(options);
    assert.equal(changes.length, 1, "Vue 反馈同一草稿不能产生重复更新");
    assert.equal(undo(view), true);
    assert.equal(changes.at(-1), "const n = 1;\n");
    assert.equal(redo(view), true);
    assert.equal(changes.at(-1), "const n = 2;\n");

    view.dispatch({ selection: { anchor: 5 } });
    const beforeExternal = changes.length;
    options = { ...options, value: "const n = 3;\n" };
    editor.update(options);
    assert.equal(view.state.doc.toString(), options.value);
    assert.equal(view.state.selection.main.head, 5, "外部修改保留未受影响的光标位置");
    assert.equal(changes.length, beforeExternal, "本地同步不能再次触发自动保存");

    openSearchPanel(view);
    assert.ok(document.querySelector(".cm-search"), "使用 CodeMirror 内置搜索");
    closeSearchPanel(view);
    options = { ...options, readOnly: true };
    editor.update(options);
    assert.equal(view.state.facet(EditorState.readOnly), true);
    assert.equal(view.contentDOM.getAttribute("contenteditable"), "false");
    assert.equal(insertNewlineAndIndent(view), false, "只读文件不能用 Enter 编辑命令修改");
    assert.equal(view.state.doc.toString(), options.value);

    options = { value: '{"ok": true}', path: "config.json", documentKey: "root:config.json", readOnly: false };
    editor.update(options);
    await editor.languageReady;
    assert.equal(view.state.facet(language)?.name, "json");
    assert.equal(undo(view), false, "切换文件后不能撤销出上一份文件的内容");
    assert.equal(changes.length, beforeExternal);

    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    assert.equal(compositions.at(-1), true, "输入法组合期间暂停业务层写入");
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
    await Promise.resolve();
    assert.equal(compositions.at(-1), false);

    editor.update({ ...options, path: "next.js", documentKey: "root:next.js", value: "let x = 0" });
    const previousLanguage = editor.languageReady;
    editor.update({ ...options, path: "plain.txt", documentKey: "root:plain.txt", value: "plain" });
    await Promise.all([previousLanguage, editor.languageReady]);
    assert.equal(view.state.doc.toString(), "plain");
    assert.equal(view.state.facet(language), null, "旧语言异步加载不能覆盖当前纯文本文件");
    assert.equal(changes.length, beforeExternal);
    editor.destroy(); editor = undefined;
    assert.equal(document.querySelector(".cm-editor"), null);
  } finally {
    editor?.destroy();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
