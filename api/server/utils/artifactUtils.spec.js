const { getArtifactDedupeKey, extractArtifactsWithMetadata } = require('./artifactUtils');

describe('Artifact Utils', () => {
    describe('getArtifactDedupeKey', () => {
        it('should prioritize identifier', () => {
            const key = getArtifactDedupeKey({
                conversationId: 'convo1',
                title: 'Title',
                identifier: 'my-id'
            });
            expect(key).toBe('convo1:my-id');
        });

        it('should fallback to normalized title', () => {
            const key = getArtifactDedupeKey({
                conversationId: 'convo1',
                title: 'My Title 123!',
            });
            expect(key).toBe('convo1:my_title_123');
        });

        it('should fallback to default if nothing provided', () => {
            const key = getArtifactDedupeKey({
                conversationId: 'convo1',
            });
            expect(key).toBe('convo1:default-artifact');
        });
    });

    describe('extractArtifactsWithMetadata', () => {
        it('should extract artifacts with metadata', () => {
            const text = `
Here is some code:
:::artifact{identifier="test-id" type="text/javascript" title="Test Code"}
\`\`\`javascript
console.log('hello');
\`\`\`
:::
End of code.
      `;

            const artifacts = extractArtifactsWithMetadata(text);
            expect(artifacts).toHaveLength(1);
            expect(artifacts[0].identifier).toBe('test-id');
            expect(artifacts[0].title).toBe('Test Code');
            expect(artifacts[0].type).toBe('text/javascript');
            expect(artifacts[0].content).toContain('console.log(\'hello\');');
        });

        it('should handle artifacts without metadata', () => {
            const text = `
:::artifact
\`\`\`
content
\`\`\`
:::
      `;
            const artifacts = extractArtifactsWithMetadata(text);
            expect(artifacts).toHaveLength(1);
            expect(artifacts[0].content).toContain('content');
        });
    });
});
