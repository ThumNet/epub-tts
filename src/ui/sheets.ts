const SHEETS = [
  { dialog: "sheet-book", opener: "open-book" },
  { dialog: "sheet-voice", opener: "open-voice" },
  { dialog: "diagnostics", opener: "open-diagnostics" },
] as const;

export type SheetId = (typeof SHEETS)[number]["dialog"];

export interface Sheets {
  close(id: SheetId): void;
}

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is missing or has the wrong type`);
  return element;
}

/**
 * Wires the three sheets. Sheet open state belongs to the dialog element, not to UiState, and `render()` never touches it.
 * Without `showModal` the sheets fall back to the plain `open` attribute: no modality, no Escape, no backdrop.
 */
export function initSheets(): Sheets {
  const modal = typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";
  const entries = SHEETS.map(({ dialog, opener }) => ({
    dialog: byId(dialog, HTMLDialogElement),
    opener: byId(opener, HTMLButtonElement),
  }));

  function close(dialog: HTMLDialogElement): void {
    if (modal) dialog.close();
    else if (dialog.hasAttribute("open")) {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    }
  }

  for (const { dialog, opener } of entries) {
    opener.addEventListener("click", () => {
      if (modal) dialog.showModal();
      else dialog.setAttribute("open", "");
    });
    dialog.querySelector(".sheet-close")?.addEventListener("click", () => close(dialog));
    // A click on the backdrop targets the dialog element, but so does a click on the dialog's own safe-area padding,
    // and so does keyboard or synthetic activation. Only a pointer click outside the dialog box is a backdrop click.
    // `detail` is 0 for keyboard and synthetic clicks and at least 1 for real pointer clicks. I chose it over a (0, 0)
    // coordinate test because (0, 0) is also a valid pointer position on the backdrop.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog || event.detail === 0) return;
      const box = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) close(dialog);
    });
    // Safari does not always return focus to the opener, so do it here for every way of closing.
    dialog.addEventListener("close", () => opener.focus());
  }

  return {
    close: (id) => {
      const entry = entries.find(({ dialog }) => dialog.id === id);
      if (entry) close(entry.dialog);
    },
  };
}
