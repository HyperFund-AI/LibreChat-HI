const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('@librechat/data-schemas');

/**
 * Executes a conversational loop with tools, enforcing strict tool usage for the final submission.
 * 
 *
 * @param {Object} params
 * @param {string} params.apiKey - Anthropic API key
 * @param {string} params.model - Model identifier
 * @param {string} params.systemPrompt - System prompt
 * @param {Array} params.messages - Initial message history
 * @param {Array} params.tools - Array of tool objects. Each must have { name, description, input_schema, execute? }
 * @param {string} [params.submissionToolName] - Name of the tool that signifies completion. Its usage returns the final result.
 * @param {string} params.agentName - Name of the agent for logging/callbacks
 * @param {Function} [params.onThinking] - Callback for thinking/status updates
 * @param {number} [params.maxTurns=10] - Maximum number of turns before giving up
 * @param {string} [params.toolChoice='auto'] - Tool choice strategy ('auto', 'any', or { type: 'tool', name: '...' })
 * @returns {Promise<any>} The input payload of the submission tool, or the final text response if no submission tool used.
 */
async function runAgentToolLoop({
    apiKey,
    model,
    systemPrompt,
    messages = [],
    tools = [],
    submissionToolName,
    agentName = 'Agent',
    onThinking,
    maxTurns = 10,
    toolChoice = 'auto',
}) {
    const client = new Anthropic({ apiKey });

    // Prepare tool definitions for the API
    const apiTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
    }));

    const history = [...messages];
    let finalResult = null;

    for (let i = 0; i < maxTurns; i++) {
        logger.debug(`[runAgentToolLoop] Turn ${i + 1}/${maxTurns} for ${agentName}`);

        // If toolChoice is a string ('auto', 'any'), format it correctly. If object, use as is.
        const tool_choice = typeof toolChoice === 'string' ? { type: toolChoice } : toolChoice;

        let currentSystemPrompt = systemPrompt;

        // Auto-generate tool instructions if tools are present
        if (apiTools.length > 0) {
            const toolInstructions = apiTools.map(t => {
                const toolDef = tools.find(original => original.name === t.name);
                const usage = toolDef?.usage || t.description;
                return `- Use \`${t.name}\` to ${usage}`;
            }).join('\n');

            currentSystemPrompt += `\n\nTOOLS:\n${toolInstructions}`;

            if (submissionToolName) {
                currentSystemPrompt += `\n\nOUTPUT FORMAT:\n- You must eventually call \`${submissionToolName}\` to complete the task.`;
            }
        }

        const response = await client.messages.create({
            model,
            max_tokens: 2000,
            system: currentSystemPrompt,
            messages: history,
            tools: apiTools.length > 0 ? apiTools : undefined,
            tool_choice: apiTools.length > 0 ? tool_choice : undefined,
        });

        const content = response.content;
        const stopReason = response.stop_reason;

        // Add assistant response to history
        history.push({ role: 'assistant', content });

        const toolUseBlocks = content.filter((c) => c.type === 'tool_use');

        if (toolUseBlocks.length > 0) {
            const toolResults = [];

            for (const block of toolUseBlocks) {
                const toolName = block.name;
                const toolInput = block.input;
                const toolId = block.id;

                logger.info(`[${agentName}] Calling tool ${toolName}`);

                if (onThinking) {
                    onThinking({
                        agent: agentName,
                        action: 'tool_use',
                        message: `Using tool ${toolName}...`,
                    });
                }

                // Handle Submission Tool
                if (submissionToolName && toolName === submissionToolName) {
                    finalResult = toolInput;
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolId,
                        content: 'Submission received.',
                    });
                    // We usually stop the loop after this turn.
                } else {
                    // execute standard tool
                    const toolDef = tools.find(t => t.name === toolName);
                    let resultText = 'Error: Tool execution failed or tool not found.';

                    const executor = toolDef?.execute || toolDef?.run;

                    if (executor) {
                        try {
                            resultText = await executor(toolInput);
                        } catch (err) {
                            resultText = `Error executing ${toolName}: ${err.message}`;
                        }
                    } else {
                        resultText = `Error: Tool ${toolName} has no execute/run method.`;
                    }

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolId,
                        content: resultText,
                    });
                }
            }

            // Add results to history
            history.push({ role: 'user', content: toolResults });

            if (finalResult) {
                break; // Loop complete
            }

        } else {
            // No tools called.
            if (response.stop_reason === 'end_turn') {
                // If we strict enforcement ('any') and a submission tool is expected, we prompt to use it.
                // Otherwise, we accept the text response.
                const isStrict = toolChoice === 'any' || (typeof toolChoice === 'object' && toolChoice.type === 'any');

                if (isStrict && submissionToolName) {
                    history.push({
                        role: 'user',
                        content: `You must use the \`${submissionToolName}\` tool to submit your result. Do not output conversational text.`,
                    });
                } else {
                    // Accept text response
                    const textBlock = content.find(c => c.type === 'text');
                    if (textBlock) {
                        finalResult = textBlock.text;
                    }
                    break;
                }
            }
        }
    }

    return { result: finalResult, messages: history };
}

/**
 * Executes a conversational loop with tools, using streaming for the assistant's response.
 * Allows real-time feedback (e.g. "thinking" characters) via onStream callback.
 * 
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {string} params.systemPrompt
 * @param {Array} params.messages
 * @param {Array} params.tools
 * @param {string} [params.submissionToolName]
 * @param {string} params.agentName
 * @param {Function} [params.onThinking] - Callback for tool usage/status updates
 * @param {Function} [params.onStream] - Callback for text content deltas (chunk) => void
 * @param {number} [params.maxTurns=10]
 * @param {string} [params.toolChoice='auto']
 * @returns {Promise<{ result: any, messages: Array }>}
 */
async function runAgentToolLoopStreaming({
    apiKey,
    model,
    systemPrompt,
    messages = [],
    tools = [],
    submissionToolName,
    agentName = 'Agent',
    onThinking,
    onStream,
    maxTurns = 10,
    toolChoice = 'auto',
}) {
    const client = new Anthropic({ apiKey });

    // Prepare tool definitions for the API
    const apiTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
    }));

    const history = [...messages];
    let finalResult = null;

    for (let i = 0; i < maxTurns; i++) {
        logger.debug(`[runAgentToolLoopStreaming] Turn ${i + 1}/${maxTurns} for ${agentName}`);

        const tool_choice = typeof toolChoice === 'string' ? { type: toolChoice } : toolChoice;
        let currentSystemPrompt = systemPrompt;

        // Auto-generate tool instructions
        if (apiTools.length > 0) {
            const toolInstructions = apiTools.map(t => {
                const toolDef = tools.find(original => original.name === t.name);
                const usage = toolDef?.usage || t.description;
                return `- Use \`${t.name}\` to ${usage}`;
            }).join('\n');
            currentSystemPrompt += `\n\nTOOLS:\n${toolInstructions}`;

            if (submissionToolName) {
                currentSystemPrompt += `\n\nOUTPUT FORMAT:\n- You must eventually call \`${submissionToolName}\` to complete the task.`;
            }
        }

        let currentMessageContent = [];
        let accumulatedText = '';

        // We need to accumulate the message to add it to history later
        // and check for tools.
        // We'll use the finalMessage helper from the SDK stream if possible, 
        // or just accumulate manualy.
        // The most robust way with the SDK helper is to await the final message.

        const stream = client.messages.stream({
            model,
            max_tokens: 2000,
            system: currentSystemPrompt,
            messages: history,
            tools: apiTools.length > 0 ? apiTools : undefined,
            tool_choice: apiTools.length > 0 ? tool_choice : undefined,
        });

        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.text) {
                const chunk = event.delta.text;
                accumulatedText += chunk;
                if (onStream) {
                    onStream(chunk);
                }
            }
        }

        const finalMessage = await stream.finalMessage();
        history.push({ role: 'assistant', content: finalMessage.content });

        const toolUseBlocks = finalMessage.content.filter(c => c.type === 'tool_use');

        if (toolUseBlocks.length > 0) {
            const toolResults = [];

            for (const block of toolUseBlocks) {
                const toolName = block.name;
                const toolInput = block.input;
                const toolId = block.id;

                logger.info(`[${agentName}] (Streamed) Calling tool ${toolName}`);

                if (onThinking) {
                    onThinking({
                        agent: agentName,
                        action: 'tool_use',
                        message: `Using tool ${toolName}...`,
                    });
                }

                if (submissionToolName && toolName === submissionToolName) {
                    finalResult = toolInput;
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolId,
                        content: 'Submission received.',
                    });
                } else {
                    const toolDef = tools.find(t => t.name === toolName);
                    let resultText = 'Error: Tool execution failed.';
                    const executor = toolDef?.execute || toolDef?.run;

                    if (executor) {
                        try {
                            // Run the tool!
                            resultText = await executor(toolInput);
                        } catch (err) {
                            resultText = `Error executing ${toolName}: ${err.message}`;
                        }
                    }

                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolId,
                        content: resultText,
                    });
                }
            }

            history.push({ role: 'user', content: toolResults });

            if (finalResult) {
                break;
            }

        } else {
            // No tools called
            if (finalMessage.stop_reason === 'end_turn') {
                const isStrict = toolChoice === 'any' || (typeof toolChoice === 'object' && toolChoice.type === 'any');
                if (isStrict && submissionToolName) {
                    history.push({
                        role: 'user',
                        content: `You must use the \`${submissionToolName}\` tool to submit your result. Do not output conversational text.`,
                    });
                } else {
                    // Try to find text content
                    const textBlock = finalMessage.content.find(c => c.type === 'text');
                    if (textBlock) {
                        finalResult = textBlock.text;
                    } else if (accumulatedText) {
                        // Fallback if finalMessage structure is unexpected
                        finalResult = accumulatedText;
                    }
                    break;
                }
            }
        }
    }

    return { result: finalResult, messages: history };
}

module.exports = {
    runAgentToolLoop,
    runAgentToolLoopStreaming,
};
