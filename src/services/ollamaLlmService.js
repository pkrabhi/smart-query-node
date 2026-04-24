const axios = require('axios');
const config = require('../config');

class LocalOllamaService {

    async generateSql(systemPrompt, userMessage) {
        if (!config.ollama.enabled) throw new Error('Ollama is disabled');
        console.log(`[Ollama] Calling API — model: ${config.ollama.model}`);

        const body = {
            model: config.ollama.model,
            max_tokens: config.ollama.maxTokens,
            temperature: config.ollama.temperature,
            stream: false,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ]
        };

        const t0 = Date.now();
        const response = await axios.post(config.ollama.apiUrl, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: config.ollama.timeoutMs
        });
        console.log(`[Ollama] Responded in ${Date.now() - t0}ms`);

        return response.data.choices[0].message.content.trim();
    }

    /** Free-form text generation (insights, summaries). Same as generateSql for Ollama. */
    async generateText(systemPrompt, userMessage) {
        return this.generateSql(systemPrompt, userMessage);
    }

    async isAvailable() {
        if (!config.ollama.enabled) return false;
        try {
            await axios.get(config.ollama.apiUrl.replace('/v1/chat/completions', '/api/tags'), { timeout: 3000 });
            return true;
        } catch { return false; }
    }

    getProviderName() { return 'Local Ollama'; }
}

module.exports = new LocalOllamaService();
