import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadEmbeddingIndex,
  saveEmbeddingIndex,
  vectorSearchZvec,
  type EmbeddingIndex,
} from './embedding.js';

const zvec = await import('@zvec/zvec').catch(() => null);
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestro-zvec-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!zvec)('Zvec embedding persistence', () => {
  it('uses safe internal IDs while preserving original chunk IDs', async () => {
    const dir = makeTempDir();
    const docIds = ['spec:project/auth#0', '知识/说明#1'];
    const index: EmbeddingIndex = {
      modelId: 'test-model',
      dimension: 3,
      docIds,
      vectors: [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])],
      chunkDocIds: ['spec:project/auth', '知识/说明'],
      builtAt: 1,
    };

    await saveEmbeddingIndex(index, dir);

    const meta = JSON.parse(readFileSync(join(dir, 'embedding.zvec.meta.json'), 'utf-8'));
    expect(meta).toMatchObject({ docIds, zvecIdEncoding: 'sha256' });

    const collection = zvec!.ZVecOpen(join(dir, 'embedding.zvec'), { readOnly: true });
    try {
      const internalId = createHash('sha256').update(docIds[0]).digest('hex');
      const fetched = collection.fetchSync({ ids: [internalId], includeVector: false, outputFields: ['docId'] });
      expect(fetched[internalId]?.fields.docId).toBe(docIds[0]);
    } finally {
      collection.closeSync();
    }

    const loaded = loadEmbeddingIndex(dir);
    expect(loaded?.docIds).toEqual(docIds);
    expect(Array.from(loaded!.vectors[0])).toEqual([1, 0, 0]);
    expect(Array.from(loaded!.vectors[1])).toEqual([0, 1, 0]);

    const results = await vectorSearchZvec(new Float32Array([1, 0, 0]), dir, 2);
    expect(results[0]?.docId).toBe(docIds[0]);
  });

  it('falls back to the binary index when the Zvec sidecar and collection disagree', async () => {
    const dir = makeTempDir();
    const index: EmbeddingIndex = {
      modelId: 'test-model',
      dimension: 2,
      docIds: ['spec:project:auth#0'],
      vectors: [new Float32Array([0.5, 0.5])],
      builtAt: 1,
    };
    await saveEmbeddingIndex(index, dir);

    const metaPath = join(dir, 'embedding.zvec.meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    meta.docIds = ['tampered:missing#0'];
    writeFileSync(metaPath, JSON.stringify(meta));

    const loaded = loadEmbeddingIndex(dir);
    expect(loaded?.docIds).toEqual(index.docIds);
    expect(Array.from(loaded!.vectors[0])).toEqual([0.5, 0.5]);
  });

  it('loads legacy collections whose sidecar has no ID encoding marker', () => {
    const dir = makeTempDir();
    const collectionPath = join(dir, 'embedding.zvec');
    const schema = new zvec!.ZVecCollectionSchema({
      name: 'embedding',
      vectors: {
        name: 'embedding',
        dataType: zvec!.ZVecDataType.VECTOR_FP32,
        dimension: 2,
        indexParams: {
          indexType: zvec!.ZVecIndexType.FLAT,
          metricType: zvec!.ZVecMetricType.COSINE,
        },
      },
      fields: [{ name: 'docId', dataType: zvec!.ZVecDataType.STRING }],
    });
    const collection = zvec!.ZVecCreateAndOpen(collectionPath, schema);
    try {
      collection.upsertSync([{
        id: 'legacy-doc#0',
        vectors: { embedding: new Float32Array([0.25, 0.75]) },
        fields: { docId: 'legacy-doc#0' },
      }]);
    } finally {
      collection.closeSync();
    }
    writeFileSync(join(dir, 'embedding.zvec.meta.json'), JSON.stringify({
      modelId: 'legacy-model',
      dimension: 2,
      builtAt: 1,
      docIds: ['legacy-doc#0'],
    }));

    const loaded = loadEmbeddingIndex(dir);
    expect(loaded?.docIds).toEqual(['legacy-doc#0']);
    expect(Array.from(loaded!.vectors[0])).toEqual([0.25, 0.75]);
  });
});
