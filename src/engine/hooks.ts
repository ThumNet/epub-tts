import type { Sentence } from "../epub";

/** Every hook is synchronous and called exactly where the old DOM access was. */
export interface EngineHooks {
  /** Was `updateControls()`. */
  notifyChange(): void;
  /** Was `statsElement.textContent = ...`. */
  setStatus(text: string): void;
  /** Was `chapterSelect.value = String(index)`. */
  showChapter(index: number): void;
  /** Was `renderText(sentences)`. */
  renderChapter(sentences: Sentence[]): void;
  /** Was the DOM part of `highlight()`. The engine keeps `currentSentence`. */
  highlight(index: number): void;
  /** Was `textElement.replaceChildren()`. */
  clearText(): void;
  /** Was `Number(chapterSelect.value)`. The DOM read stays in the shell. */
  getSelectedChapter(): number;
}
