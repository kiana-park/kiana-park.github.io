// "Save as PDF" for shared pages (docs/s/*). Upload adds this script to a page
// when its PDF option is on. The button opens the print dialog, where every
// browser offers "Save as PDF"; the page's own print styles lay out the PDF.
// Decks get the button at the end of their #hud bar, in the deck's own
// style; other pages get a small one in the bottom right corner.
// While printing, closed <details> are opened so their text is in the PDF.

(() => {
  const korean = /^ko\b/i.test(document.documentElement.lang);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = korean ? "PDF 저장" : "Save as PDF";
  button.title = korean ? "인쇄 창에서 ‘PDF로 저장’을 고르세요" : "Choose “Save as PDF” in the print dialog";
  button.addEventListener("click", () => window.print());

  const hud = document.getElementById("hud");
  if (hud) {
    hud.append(button);
  } else {
    const style = document.createElement("style");
    style.textContent = `
      .pdf-button { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        padding: 8px 14px; border: 0; border-radius: 999px;
        background: rgba(14, 22, 36, 0.78); color: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
        font: inherit; font-size: 13px; font-weight: 500; line-height: 1.2; cursor: pointer;
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
      .pdf-button:hover { background: rgba(14, 22, 36, 0.92); }
      @media print { .pdf-button { display: none !important; } }`;
    button.className = "pdf-button";
    document.head.append(style);
    document.body.append(button);
  }

  let opened = [];
  addEventListener("beforeprint", () => {
    opened = [...document.querySelectorAll("details:not([open])")];
    opened.forEach((details) => { details.open = true; });
  });
  addEventListener("afterprint", () => {
    opened.forEach((details) => { details.open = false; });
    opened = [];
  });
})();
