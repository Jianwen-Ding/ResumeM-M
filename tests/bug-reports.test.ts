import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bugReportsApi } from '../src/server/bug-reports.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
describe('the independent bug inbox', () => {
  it('keeps notes, time, builds and image files; a retry keeps the original', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-bugs-'));
    try {
      const app = express().use(express.json()).use('/bugs', bugReportsApi(root, 'server-build'));
      const report = { id: randomUUID(), text: 'The folder did not update.', createdAt: new Date().toISOString(),
        version: '0.1.0', extensionBuild: 'abc123', screenshots: [png] };
      const saved = await request(app).post('/bugs').send(report).expect(201);
      expect(saved.body.directory).toBe(path.join(root, report.id));
      const kept = JSON.parse(fs.readFileSync(path.join(saved.body.directory, 'report.json'), 'utf8'));
      expect(kept).toMatchObject({ text: report.text, createdAt: report.createdAt, version: '0.1.0',
        extensionBuild: 'abc123', serverBuild: 'server-build', status: 'new', screenshots: ['screenshot-1.png'] });
      expect(fs.readFileSync(path.join(saved.body.directory, 'screenshot-1.png'))).toEqual(Buffer.from(png.split(',')[1]!, 'base64'));
      await request(app).post('/bugs').send({ ...report, text: 'Retry must not replace the report' }).expect(200);
      const listed = await request(app).get('/bugs').expect(200);
      expect(listed.body.reports).toEqual([kept]);
      expect(fs.readdirSync(root)).toEqual([report.id]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects unsafe IDs, oversized images, invalid image bytes and missing notes before writing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-bugs-'));
    try {
      const app = express().use(express.json({ limit: '10mb' })).use('/bugs', bugReportsApi(root, 'server'));
      const report = { id: randomUUID(), text: 'Bug', createdAt: new Date().toISOString(), version: '1', extensionBuild: 'build', screenshots: [] };
      for (const change of [{ id: '../../elsewhere' }, { text: ' ' }, { createdAt: 'yesterday' },
        { screenshots: ['data:image/png;base64,YmFk'] }, { screenshots: [png, png, png, png] },
        { screenshots: ['data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(4 * 1024 * 1024)]).toString('base64')] }]) {
        await request(app).post('/bugs').send({ ...report, ...change }).expect(400);
      }
      expect(fs.readdirSync(root)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
