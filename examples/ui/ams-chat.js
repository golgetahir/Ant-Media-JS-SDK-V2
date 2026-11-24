import { icon } from "./icons.js";
import { SessionElement, reportFailure, isWaiting } from "./session-element.js";

// a received text as JSON; undefined when it is not JSON
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
// only these types are previewed; anything else is kept as plain bytes, never opened as a page
const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// sendData() rejects binary over 64 MB; checked here first so no announcement goes out
const MAX_FILE = 64 * 1048576;

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

/**
 * Text and file chat over the session's data channel; usable while the channel is open. What the
 * page puts inside goes into the message area, e.g. an `.empty` state shown until the first message.
 * With `author` set it is a room's chat: text only, named messages sent through `author.session`.
 */
class AmsChat extends SessionElement {
  #open = false;
  #announced = null;
  #author = null;

  /** `{ session, name }`: the publish session that sends, and the name shown to the others; null for none. */
  set author(author) {
    this.#author = author;
    this.paint();
  }

  connectedCallback() {
    if (this.querySelector("form")) return;
    const own = [...this.children];
    this.innerHTML = `
      <div class="msgs" role="log" aria-label="Messages"></div>
      <form class="input">
        <input aria-label="Message" placeholder="Write a message" autocomplete="off">
        <input type="file" multiple hidden>
        <button class="mini files" type="button" aria-label="Send a file" title="Send a file">${icon("clip")}</button>
        <button class="mini" aria-label="Send">${icon("send")}</button>
      </form>
      <p class="hint">Text<span class="files"> and files</span> over the stream's data channel, which the server application must allow.<span class="files"> Drop a file here to send it.</span></p>`;
    const [msgs, form] = this.children;
    msgs.append(...own);
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
      msgs.classList.toggle("drop", this.#usable() && !this.#author);
    };
    this.ondragleave = (e) => this.contains(e.relatedTarget) || msgs.classList.remove("drop");
    this.ondrop = (e) => {
      e.preventDefault();
      msgs.classList.remove("drop");
      if (this.#usable() && !this.#author) this.#sendFiles(e.dataTransfer.files);
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

  // not while a played stream's source is away
  #usable() {
    return this.#open && !!this.session && this.session.state !== "ended" && !isWaiting(this.session);
  }

  paint() {
    if (!this.querySelector("form")) return;
    for (const control of this.querySelector("form").elements) control.disabled = !this.#usable();
    // a file is an announcement, then its bytes: that cannot work with several senders
    for (const files of this.querySelectorAll(".files")) files.hidden = !!this.#author;
  }

  // the samples' own convention on top of sendData(): a file is a JSON text announcing it, then its bytes.
  // an announcement waits for the bytes right after it; bytes without one are a nameless file
  #receive(data) {
    if (typeof data !== "string") {
      const { file = "file.bin", type = "" } = this.#announced ?? {};
      this.#announced = null;
      this.#addFile(new Blob([data], { type: IMAGE.test(type) ? type : "application/octet-stream" }), file);
      return;
    }
    const m = parse(data);
    // a room's chat message, named; the server sends my own back to me
    if (m?.eventType === "MESSAGE_RECEIVED" && typeof m.message === "string") {
      if (m.senderId !== this.#author?.session.streamId) this.#add(m.message, false, m.name);
      return;
    }
    // the server's and applications' own messages, not chat; a pending announcement still waits for its bytes
    if (typeof m?.eventType === "string") return;
    this.#announced = typeof m?.file === "string" ? m : null;
    if (!this.#announced) this.#add(data);
  }

  async #send() {
    const input = this.querySelector("input");
    const text = input.value.trim();
    if (!text) return;
    // in a room: the convention of Ant Media's conference app, so both can talk in one room
    const author = this.#author;
    const data = author
      ? JSON.stringify({ eventType: "MESSAGE_RECEIVED", message: text, name: author.name, senderId: author.session.streamId })
      : text;
    try {
      await (author?.session ?? this.session).sendData(data);
    } catch (e) {
      reportFailure(this, "sendData()", e);
      return;
    }
    input.value = "";
    this.#add(text, true);
  }

  // a file shows at once as "Sending…" and gets its time once all of it is handed to the channel
  async #sendFiles(files) {
    for (const file of files) {
      if (file.size > MAX_FILE) {
        reportFailure(this, file.name, { code: "file_too_large" });
        continue;
      }
      const card = this.#addFile(file, file.name, true, "Sending…");
      card.classList.add("sending");
      try {
        await this.session.sendData(JSON.stringify({ file: file.name, size: file.size, type: file.type }));
        await this.session.sendData(await file.arrayBuffer());
      } catch (e) {
        card.remove();
        reportFailure(this, "sendData()", e);
        return;
      }
      card.classList.remove("sending");
      card.querySelector("time").textContent = clock();
    }
  }

  #addFile(blob, name, mine = false, time) {
    const card = document.createElement("ams-file");
    card.show(blob, name, mine);
    return this.#append(card, time);
  }

  // text only: received data is never HTML
  #add(text, mine = false, name = "") {
    const msg = document.createElement("div");
    msg.className = mine ? "msg me" : "msg";
    msg.textContent = text;
    if (name) msg.prepend(Object.assign(document.createElement("b"), { textContent: name }));
    this.#append(msg);
  }

  // adds the time and keeps the newest in view, again once a preview has its height
  #append(msg, time = clock()) {
    const msgs = this.firstElementChild;
    const end = () => (msgs.scrollTop = msgs.scrollHeight);
    msg.append(Object.assign(document.createElement("time"), { textContent: time }));
    msgs.append(msg);
    end();
    msg.querySelector("img")?.addEventListener("load", end, { once: true });
    return msg;
  }
}

customElements.define("ams-chat", AmsChat);
