const { chunkText, cosineSimilarity } = require('./vectorUtils');

describe('Vector Utils', () => {
  describe('chunkText', () => {
    it('should split text into chunks', async () => {
      const text = 'a'.repeat(2500);
      // default chunk size 1000, overlap 200
      const chunks = await chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should handle small text', async () => {
      const text = 'Hello world';
      const chunks = await chunkText(text);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe('Hello world');
    });
  });

  describe('cosineSimilarity', () => {
    it('should calculate similarity correctly', () => {
      const vecA = [1, 0];
      const vecB = [1, 0];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(1);
    });

    it('should handle orthogonal vectors', () => {
      const vecA = [1, 0];
      const vecB = [0, 1];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(0);
    });

    it('should handle opposite vectors', () => {
      const vecA = [1, 0];
      const vecB = [-1, 0];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(-1);
    });
  });
});
