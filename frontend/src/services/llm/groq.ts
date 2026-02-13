import Groq from 'groq-sdk';
import config from '../../config';
import logger from '../../utils/logger';
import { retry } from '../../utils/retry';

interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * Groq LLM Service
 * Handles streaming chat completions with ultra-low latency
 */
export class GroqLLMService {
    private client: Groq;
    private conversationHistory: Message[] = [];
    private customSystemPrompt: string | null = null;

    constructor() {
        this.client = new Groq({
            apiKey: config.groq.apiKey,
        });

        this.resetToSystemPrompt();
    }

    /**
     * Set a custom system prompt
     */
    setSystemPrompt(prompt: string): void {
        this.customSystemPrompt = prompt;
        this.resetToSystemPrompt();
    }

    /**
     * Reset history with only system prompt
     */
    private resetToSystemPrompt(): void {
        this.conversationHistory = [
            {
                role: 'system',
                content: this.customSystemPrompt || config.systemPrompt,
            },
        ];
    }

    /**
     * Generate streaming response from user input
     * Returns async generator that yields text chunks as they arrive
     */
    async *streamResponse(userInput: string | null): AsyncGenerator<string, void, unknown> {
        // If userInput is null, we are generating an initial greeting based on system prompt
        if (userInput) {
            this.conversationHistory.push({
                role: 'user',
                content: userInput,
            });
        }

        const startTime = Date.now();
        let fullResponse = '';

        try {
            if (userInput) {
                logger.info('Sending to Groq LLM', { userInput });
            } else {
                logger.info('Generating dynamic AI greeting from Groq');
            }

            // Create streaming completion with retry logic
            const stream = await retry(
                () =>
                    this.client.chat.completions.create({
                        model: config.groq.model,
                        messages: this.conversationHistory,
                        stream: true,
                        temperature: 0.7,
                        max_tokens: 150, // Keep responses short for voice
                        top_p: 1,
                    }),
                {
                    maxAttempts: 3,
                    delayMs: 500,
                }
            );

            // Stream chunks as they arrive
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content;

                if (content) {
                    fullResponse += content;
                    yield content;
                }
            }

            // Add assistant response to history
            this.conversationHistory.push({
                role: 'assistant',
                content: fullResponse,
            });

            const latency = Date.now() - startTime;
            logger.info('LLM response complete', {
                latency: `${latency}ms`,
                responseLength: fullResponse.length,
            });

        } catch (error) {
            logger.error('Groq LLM error', { error });
            throw error;
        }
    }

    /**
     * Get conversation history
     */
    getHistory(): Message[] {
        return [...this.conversationHistory];
    }

    /**
     * Clear conversation history (keeps system prompt)
     */
    clearHistory(): void {
        this.resetToSystemPrompt();
        logger.info('Conversation history cleared');
    }

    /**
     * Add a message to history manually (useful for barge-in scenarios)
     */
    addToHistory(role: 'user' | 'assistant', content: string): void {
        this.conversationHistory.push({ role, content });
    }
}
