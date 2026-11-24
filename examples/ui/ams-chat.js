import { icon } from "./icons.js";
import { SessionElement, reportFailure } from "./session-element.js";

// the samples' own convention on top of sendData(): a file is a JSON text announcing it, then its bytes
const announcement = (text) => {
  try {
    const m = JSON.parse(text);
    return typeof m?.file === "string" ? m : null;
  } catch {
    return null;
  }
};
// only these types are previewed; anything else is kept as plain bytes, never opened as a page
const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** A file in the chat: its name, size, a download link and an image preview. Its object URL lives as long as the card. */
class AmsFile extends HTMLElement {
  #url;

  show(blob, name, mine) {
    this.#url = URL.createObjectURL(blob);
    this.className = mine ? "msg file me" : "msg file";
    this.innerHTML = `${IMAGE.test(blob.type) ? "<img>" : ""}<a>${icon("file")}<span></span><small></small></a>`;
    const img = this.querySelector("img");
    if (img) Object.assign(img, { src: this.#url, alt: name });
    const link = this.querySelector("a");
    Object.assign(link, { href: this.#url, download: name, title: `Download ${name}` });
    link.querySelector("span").textContent = name;
    link.querySelector("small").textContent = size(blob.size);
  }

  disconnectedCallback() {
    URL.revokeObjectURL(this.#url);
  }
}
customElements.define("ams-file", AmsFile);

/** Text and file chat over the session's data channel; usable while the channel is open. */
class AmsChat extends SessionElement {
  #open = false;
  #announced = null;

  connectedCallback() {
    this.innerHTML = `
      <div class="msgs" role="log" aria-label="Messages"></div>
      <form class="input">
        <input aria-label="Message" placeholder="Message everyone on this stream" autocomplete="off">
        <input type="file" multiple hidden>
        <button class="mini" type="button" aria-label="Send a file" title="Send a file">${icon("clip")}</button>
        <button class="mini" aria-label="Send">${icon("send")}</button>
      </form>
      <p class="hint">Text and files over the stream's data channel, which the server application must allow. Drop a file here to send it.</p>`;
    const [msgs, form] = this.children;
    const [, picker, attach] = form.elements;
    form.onsubmit = (e) => {
      e.preventDefault();
      this.#send();
    };
    attach.onclick = () => picker.click();
    picker.onchange = () => {
      this.#sendFiles(picker.files);
      picker.value = "";
    };
    // a file dropped anywhere on the chat; never let the browser open it instead
    this.ondragover = (e) => {
      e.preventDefault();
      msgs.classList.toggle("drop", this.#usable());
    };
    this.ondragleave = (e) => this.contains(e.relatedTarget) || msgs.classList.remove("drop");
    this.ondrop = (e) => {
      e.preventDefault();
      msgs.classList.remove("drop");
      if (this.#usable()) this.#sendFiles(e.dataTransfer.files);
    };
    this.paint();
  }

  listen(session) {
    this.#open = false;
    this.#announced = null;
    const open = (open) => () => {
      this.#open = open;
      this.paint();
    };
    return [
      session.on("data_channel_opened", open(true)),
      session.on("data_channel_closed", open(false)),
      session.on("data_received", ({ data }) => this.#receive(data)),
    ];
  }

  #usable() {
    return this.#open && !!this.session && this.session.state !== "ended";
  }

  paint() {
    for (const control of this.querySelectorAll("input, button")) control.disabled = !this.#usable();
  }

  // an announcement waits for the bytes right after it; bytes without one are a nameless file
  #receive(data) {
    if (typeof data !== "string") {
      const { file = "file.bin", type = "" } = this.#announced ?? {};
      this.#announced = null;
      this.#addFile(new Blob([data], { type: IMAGE.test(type) ? type : "application/octet-stream" }), file);
      return;
    }
    this.#announced = announcement(data);
    if (!this.#announced) this.#add(data);
  }

  async #send() {
    const input = this.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    try {
      await this.session.sendData(text);
    } catch (e) {
      reportFailure(this, "sendData()", e);
      return;
    }
    input.value = "";
    this.#add(text, true);
  }

  async #sendFiles(files) {
    for (const file of files) {
      try {
        await this.session.sendData(JSON.stringify({ file: file.name, size: file.size, type: file.type }));
        await this.session.sendData(await file.arrayBuffer());
      } catch (e) {
        reportFailure(this, "sendData()", e);
        return;
      }
      this.#addFile(file, file.name, true);
    }
  }

  #addFile(blob, name, mine = false) {
    const card = document.createElement("ams-file");
    this.#append(card);
    card.show(blob, name, mine);
  }

  // text only: received data is never HTML
  #add(text, mine = false) {
    const msg = document.createElement("div");
    msg.className = mine ? "msg me" : "msg";
    msg.textContent = text;
    this.#append(msg);
  }

  #append(msg) {
    const msgs = this.firstElementChild;
    msgs.append(msg);
    msgs.scrollTop = msgs.scrollHeight;
  }
}

customElements.define("ams-chat", AmsChat);
