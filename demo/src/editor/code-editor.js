import { basicSetup } from "codemirror";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { indentWithTab, isolateHistory } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const externalChange = Annotation.define();

// Keep editor transactions separate from versioned filesystem writes.
export function createCodeEditor({ parent, onChange, onCompositionChange, ...initial }) {
  const permission = new Compartment();
  const language = new Compartment();
  let current = initial;
  let destroyed = false;
  let languageGeneration = 0;
  let languageReady = Promise.resolve();
  let composing = false;

  function setComposing(value) {
    if (destroyed || composing === value) return;
    composing = value;
    onCompositionChange(value);
  }
  const access = (readOnly) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ "aria-label": "文本文件内容", "aria-readonly": String(readOnly),
      "aria-multiline": "true", role: "textbox", tabindex: "0", spellcheck: "false" })];
  function createState({ value, readOnly }) {
    return EditorState.create({ doc: value, extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      permission.of(access(readOnly)),
      language.of([]),
      placeholder("从左侧打开文件，修改后自动同步到本地。"),
      EditorView.domEventHandlers({
        compositionstart() { setComposing(true); },
        compositionend() {
          // CodeMirror must finish processing the native event before resuming saves.
          queueMicrotask(() => { if (!destroyed) setComposing(false); });
        },
        blur() { queueMicrotask(() => { if (!destroyed && !view.composing) setComposing(false); }); },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((transaction) => transaction.annotation(externalChange))) return;
        if (update.view.composing) setComposing(true);
        onChange(update.state.doc.toString());
      }),
    ] });
  }
  const view = new EditorView({ parent, state: createState(initial) });

  function loadLanguage(path) {
    const generation = ++languageGeneration;
    const description = LanguageDescription.matchFilename(languages, path || "");
    view.dispatch({ effects: language.reconfigure([]) });
    languageReady = (description ? description.load() : Promise.resolve([])).then((support) => {
      if (!destroyed && generation === languageGeneration) view.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => {
      // Editing remains available as plain text if an optional language chunk fails to load.
    });
  }
  loadLanguage(initial.path);

  return {
    view,
    get languageReady() { return languageReady; },
    update(next) {
      if (destroyed) return;
      if (next.documentKey !== current.documentKey) {
        setComposing(false);
        view.setState(createState(next)); // Each file gets its own selection and undo history.
        loadLanguage(next.path);
      } else {
        if (next.readOnly !== current.readOnly) view.dispatch({ effects: permission.reconfigure(access(next.readOnly)) });
        if (next.path !== current.path) loadLanguage(next.path);
        const previous = view.state.doc.toString();
        if (next.value !== previous) {
          // Replace only the changed span so local updates retain the cursor and viewport.
          let from = 0;
          let oldEnd = previous.length;
          let newEnd = next.value.length;
          while (from < oldEnd && from < newEnd && previous[from] === next.value[from]) from++;
          while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next.value[newEnd - 1]) { oldEnd--; newEnd--; }
          view.dispatch({ changes: { from, to: oldEnd, insert: next.value.slice(from, newEnd) },
            annotations: [externalChange.of(true), Transaction.addToHistory.of(false), isolateHistory.of("full")] });
        }
      }
      current = next;
    },
    destroy() {
      setComposing(false);
      destroyed = true;
      languageGeneration++;
      view.destroy();
    },
  };
}
