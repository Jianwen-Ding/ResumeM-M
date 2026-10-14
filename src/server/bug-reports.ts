import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { decodeScreenshot } from '../errorlog/screenshots.js';

/** Independent of resume saves: diagnostics must work with no save open. */
export function bugReportsApi(
  root: string,
  build: string,
  /** Told of each report once it is in the inbox, with its screenshots as sent; see the error log in index.ts. */
  saved?: (report: { text: string; version: string; extensionBuild: string }, screenshots: string[]) => void,
) {
  const api = express.Router();
  api.get('/', (_req, res) => {
    const reports = fs.existsSync(root) ? fs.readdirSync(root)
      .filter((id) => /^[0-9a-f-]{36}$/.test(id))
      .flatMap((id) => {
        try { return [JSON.parse(fs.readFileSync(path.join(root, id, 'report.json'), 'utf8'))]; }
        catch { return []; }
      }) : [];
    res.json({ directory: root, reports: reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });
  api.post('/', (req, res, next) => {
    const report = req.body;
    if (!report || typeof report.id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(report.id)
      || typeof report.text !== 'string' || !report.text.trim() || report.text.length > 20000
      || typeof report.createdAt !== 'string' || !Number.isFinite(Date.parse(report.createdAt))
      || typeof report.version !== 'string' || report.version.length > 100
      || typeof report.extensionBuild !== 'string' || report.extensionBuild.length > 100
      || !Array.isArray(report.screenshots) || report.screenshots.length > 3) {
      res.status(400).json({ error: 'A report needs notes, a valid time and version, and up to three screenshots.' });
      return;
    }
    const images: { extension: string; bytes: Buffer }[] = [];
    let total = 0;
    for (const image of report.screenshots) {
      const match = typeof image === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
      if (!match) { res.status(400).json({ error: 'Screenshots must be PNG, JPEG or WebP images.' }); return; }
      // The bytes decide, by the same check the error log makes. See `decodeScreenshot`.
      const decoded = decodeScreenshot(image);
      total += decoded?.bytes.length ?? 0;
      if (!decoded || total > 4 * 1024 * 1024) { res.status(400).json({ error: 'Use valid screenshots totaling at most 4 MB.' }); return; }
      images.push(decoded);
    }
    const destination = path.join(root, report.id);
    let temporary: string | undefined;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      // Retrying after a lost response returns the existing receipt.
      if (fs.existsSync(destination)) {
        res.json({ id: report.id, directory: destination, alreadySaved: true }); return;
      }
      temporary = fs.mkdtempSync(path.join(root, '.pending-'));
      const screenshots = images.map((image, i) => {
        const name = `screenshot-${i + 1}.${image.extension}`;
        fs.writeFileSync(path.join(temporary!, name), image.bytes, { mode: 0o600 });
        return name;
      });
      const kept = { schemaVersion: 1, id: report.id, status: 'new', text: report.text.trim(),
        createdAt: report.createdAt, receivedAt: new Date().toISOString(), version: report.version,
        extensionBuild: report.extensionBuild, serverBuild: build, screenshots };
      fs.writeFileSync(path.join(temporary, 'report.json'), JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, destination);
      temporary = undefined;
      res.status(201).json({ id: report.id, directory: destination });
      saved?.({ text: kept.text, version: kept.version, extensionBuild: kept.extensionBuild }, report.screenshots);
    } catch (error) { next(error); }
    finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  return api;
}
