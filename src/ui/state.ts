/** Text the shell shows. DOM-free. Initial values match the initial text in `index.html`. */
export interface UiState {
  status: string;
  bookInfo: string;
  copyStatus: string;
  selectedChapter: number;
}

export function createUiState(): UiState {
  return { status: "Idle.", bookInfo: "", copyStatus: "", selectedChapter: 0 };
}
