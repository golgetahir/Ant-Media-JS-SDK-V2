import { icon } from "./icons.js";
import { reportFailure } from "./session-element.js";

/** Copy `text` to the clipboard and show a check on `button` for a moment. */
export async function copy(button, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // no clipboard outside https and localhost
    reportFailure(button, "copy", e);
    return;
  }
  const label = (button.dataset.label ??= button.getAttribute("aria-label"));
  button.innerHTML = icon("check");
  button.setAttribute("aria-label", "Copied");
  setTimeout(() => {
    button.innerHTML = icon("copy");
    button.setAttribute("aria-label", label);
  }, 1200);
}
