/**
 * The PDF preview, drawn with pdf.js rather than the browser's PDF plugin.
 *
 * The plugin cannot be made to update without flashing. Pointing an iframe at
 * a new PDF tears the old document down before the new one paints, and the
 * usual double-buffering trick does not help: Chrome stops compositing the
 * frame showing the old document the moment another one starts loading, so the
 * pane goes empty for a few hundred milliseconds on every recompile. With a
 * live preview that recompiles as you type, that is a strobe light.
 *
 * Rendering ourselves removes the problem at the root. Each page is drawn into
 * an offscreen canvas and only swapped into the document once it is complete,
 * so the previous page stays on screen until the exact frame the new one
 * replaces it. It also gets rid of the viewer's toolbar and scrollbars, which
 * we were hiding with URL parameters and a dark surround anyway.
 *
 * pdf.js (Mozilla, Apache-2.0) is vendored under web/vendor so the app keeps
 * working with no network and no build step. It is a viewer only — every PDF
 * that leaves this machine is still produced by the real LaTeX engine.
 */

import * as pdfjs from './vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

/** Cap the backing store: past this, extra pixels cost time and show nothing. */
const MAX_SCALE = 2.5;

export function createPreview(container) {
  const pages = document.createElement('div');
  pages.className = 'pdf-pages';
  container.append(pages);

  let token = 0;
  let current = null; // the document on screen, kept until its replacement is ready
  let currentUrl = null;

  /** Render every page of `doc` offscreen at the width available. */
  async function renderAll(doc, width) {
    const canvases = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      // Fit the pane's width, then account for the display's pixel density so
      // small type stays legible.
      const scale = Math.min((width || unscaled.width) / unscaled.width, MAX_SCALE);
      const viewport = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // CSS size is the layout size; the backing store above is the sharp one.
      canvas.style.width = `${Math.floor(unscaled.width * scale)}px`;
      canvas.style.height = `${Math.floor(unscaled.height * scale)}px`;
      canvas.className = 'pdf-page';

      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      canvases.push(canvas);
    }
    return canvases;
  }

  return {
    /**
     * Show a PDF. Resolves once it is on screen; the previous one stays
     * visible until then, and a call that is superseded by a newer one is
     * abandoned without touching the display.
     */
    async show(url) {
      const mine = ++token;
      const width = pages.clientWidth || container.clientWidth || 600;

      const doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
      if (mine !== token) {
        doc.destroy();
        return;
      }

      const canvases = await renderAll(doc, width);
      if (mine !== token) {
        doc.destroy();
        return;
      }

      // One swap, fully drawn: this is the frame where the page changes.
      pages.replaceChildren(...canvases);
      container.classList.add('loaded');

      current?.destroy();
      current = doc;
      currentUrl = url;
    },

    /** Re-render what is already shown, for a pane that changed width. */
    async redraw() {
      if (currentUrl) await this.show(currentUrl);
    },

    /**
     * Take the page down, because there is nothing to show any more.
     *
     * Deleting the last sentence of a cover letter took the `loaded` class
     * off the frame, which brought the "type a first sentence and it appears
     * here" placeholder back — over the top of the page pdf.js had already
     * drawn, which was still sitting there. The two rendered on top of each
     * other, and the letter the user had just cleared was still legible
     * underneath the invitation to start writing it.
     *
     * Hiding the placeholder instead would have been the wrong half: an empty
     * letter has no page, and the last one is not a preview of it.
     *
     * `token` moves so that a compile already in flight cannot draw its
     * result into a pane that has since been emptied.
     */
    clear() {
      token++;
      pages.replaceChildren();
      container.classList.remove('loaded');
      current?.destroy();
      current = null;
      currentUrl = null;
    },
  };
}
