const axios = require('axios');
const config = require('../config');

class NvidiaLlmService {

    /**
     * Generate SQL by calling NVIDIA NIM API.
     */
    async generateSql(systemPrompt, userMessage) {
        console.log(`[NVIDIA] Calling API — model: ${config.nvidia.model}`);

        const body = {
            model: config.nvidia.model,
            max_tokens: config.nvidia.maxTokens,
            temperature: config.nvidia.temperature,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ]
        };

        const t0 = Date.now();
        const response = await axios.post(config.nvidia.apiUrl, body, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.nvidia.apiKey}`
            },
            timeout: config.nvidia.timeoutMs
        });

        const elapsed = Date.now() - t0;
        console.log(`[NVIDIA] Responded in ${elapsed}ms — status: ${response.status}`);

        const rawData = response.data;
        const rawStr = JSON.stringify(rawData).substring(0, 500);
        console.log(`[NVIDIA] Raw response (first 500): ${rawStr}...`);

        const sql = this._extractContent(rawData);
        console.log(`[NVIDIA] Extracted SQL (${sql.length} chars): ${sql.substring(0, 200)}${sql.length > 200 ? '...' : ''}`);

        const cleaned = this._cleanSqlOutput(sql);
        const upper = cleaned.trim().toUpperCase();
        if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
            throw new Error(`Non-SQL response from model (${cleaned.length} chars): "${cleaned.substring(0, 100)}"`);
        }
        return cleaned;
    }

    /**
     * Extract SQL content from response.
     * Handles: standard content, null content with reasoning, text field.
     */
    _extractContent(data) {
        const choices = data.choices;
        if (!choices || !choices.length) throw new Error('Invalid API response: no choices');

        const message = choices[0].message;
        let content = null;

        if (message) {
            // 1. Try content field (standard) — extract clean SQL, not just detect "SELECT" in text
            if (message.content && message.content !== 'null' && message.content.trim()) {
                const extracted = this._extractSqlFromText(message.content);
                if (extracted) {
                    content = extracted;
                    console.log(`[NVIDIA] Found SQL in message.content (${content.length} chars)`);
                } else {
                    console.log(`[NVIDIA] message.content has no extractable SQL (${message.content.length} chars) — will try reasoning field`);
                }
            }

            // 2. Try reasoning field (reasoning models like Nemotron)
            //    Used when content is null, empty, or non-SQL
            if (!content) {
                const reasoning = message.reasoning || message.reasoning_content;
                if (reasoning) {
                    console.log(`[NVIDIA] Extracting SQL from reasoning field (${reasoning.length} chars)`);
                    content = this._extractSqlFromReasoning(reasoning);
                }
            }

            // 3. Fall back to raw content even if non-SQL (let downstream validation reject it)
            if (!content && message.content && message.content.trim()) {
                content = message.content;
                console.log(`[NVIDIA] Falling back to raw message.content (${content.length} chars)`);
            }
        }

        // 3. Try text field (older format)
        if (!content && choices[0].text) {
            content = choices[0].text;
        }

        if (!content || !content.trim()) {
            throw new Error('LLM returned empty content.');
        }
        return content;
    }

    /**
     * Extract clean SQL from any text (content or reasoning).
     * Priority: ```sql block → last line-starting SELECT/WITH → first line-starting SELECT/WITH.
     * Returns null if no valid SQL found.
     */
    _extractSqlFromText(text) {
        if (!text || !text.trim()) return null;

        // 1. Strip <think> blocks first
        let s = text;
        if (s.includes('</think>')) s = s.substring(s.lastIndexOf('</think>') + 8).trim();
        if (s.includes('<|/think|>')) s = s.substring(s.lastIndexOf('<|/think|>') + 10).trim();

        // 2. Fast path: content IS pure SQL (starts directly with SELECT/WITH after trim)
        //    Handles: "SELECT\n    col," or "SELECT col," or "WITH cte AS..."
        const upper = s.trimStart().toUpperCase();
        if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
            const firstWord = upper.split(/[\s\n]/)[0];
            if (firstWord === 'SELECT' || firstWord === 'WITH') {
                return s.trim();
            }
        }

        // 3. ```sql code block — most reliable for mixed content
        const codeIdx = s.lastIndexOf('```sql');
        if (codeIdx >= 0) {
            let after = s.substring(codeIdx + 6);
            const endIdx = after.indexOf('```');
            const sql = (endIdx > 0 ? after.substring(0, endIdx) : after).trim();
            if (/^(SELECT|WITH)(\s|\n)/i.test(sql)) return sql;
        }

        // Also try generic ``` block
        const genIdx = s.lastIndexOf('```\n');
        if (genIdx >= 0) {
            let after = s.substring(genIdx + 4);
            const endIdx = after.indexOf('```');
            const block = (endIdx > 0 ? after.substring(0, endIdx) : after).trim();
            if (/^(SELECT|WITH)(\s|\n)/i.test(block)) return block;
        }

        // 4. Find last line that starts with SELECT or WITH (line-boundary, not mid-prose)
        //    FIX: use (\s|\n|$) not \s+ so "SELECT\n" (SELECT alone on a line) is matched
        const lines = s.split('\n');
        const SQL_LINE  = /^(SELECT|WITH)(\s|$)/i;
        const PROSE_WORDS = /^(SELECT\s+query|SELECT\s+statement|WITH\s+the|WITH\s+this|WITH\s+regard)/i;

        for (let i = lines.length - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (SQL_LINE.test(trimmed) && !PROSE_WORDS.test(trimmed)) {
                const candidate = lines.slice(i).join('\n').trim();
                if (candidate.length > 30) return candidate;
            }
        }

        return null;
    }

    /**
     * Extract actual SQL from reasoning text.
     * Delegates to _extractSqlFromText which handles all cases.
     */
    _extractSqlFromReasoning(reasoning) {
        return this._extractSqlFromText(reasoning);
    }

    /**
     * Clean LLM output: strip <think>, markdown fences, preamble text.
     */
    _cleanSqlOutput(raw) {
        if (!raw || !raw.trim()) return '';
        let s = raw.trim();

        // Strip <think> blocks
        if (s.includes('</think>')) s = s.substring(s.lastIndexOf('</think>') + 8).trim();
        if (s.includes('<|/think|>')) s = s.substring(s.lastIndexOf('<|/think|>') + 10).trim();

        // Strip markdown fences
        if (s.startsWith('```sql')) s = s.substring(6);
        else if (s.startsWith('```')) s = s.substring(3);
        if (s.endsWith('```')) s = s.substring(0, s.length - 3);
        s = s.trim();

        // Find SELECT/WITH if there's preamble text
        // Use line-boundary match to avoid grabbing "SELECT" from prose like "generate a SELECT query"
        const upper = s.toUpperCase();
        if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
            // Match SELECT/WITH only at start of a line (not mid-sentence)
            const lineSelectMatch = s.match(/(?:^|\n)(SELECT |WITH )/i);
            if (lineSelectMatch) {
                const startIdx = s.indexOf(lineSelectMatch[0]) + (lineSelectMatch[0].startsWith('\n') ? 1 : 0);
                s = s.substring(startIdx);
            }
        }

        // Remove trailing semicolons
        while (s.endsWith(';')) s = s.substring(0, s.length - 1).trim();
        return s;
    }

    /**
     * Generate free-form text (insight, summary, explanation) using NVIDIA NIM.
     * Unlike generateSql(), this does NOT enforce SELECT/WITH validation.
     * Used by explainService and any non-SQL LLM calls.
     */
    async generateText(systemPrompt, userMessage) {
        console.log(`[NVIDIA] Calling API (text mode) — model: ${config.nvidia.model}`);

        const body = {
            model:       config.nvidia.model,
            max_tokens:  Math.min(config.nvidia.maxTokens, 1024), // insights don't need much
            temperature: 0.3,  // slightly more creative than SQL generation
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userMessage  }
            ]
        };

        const t0 = Date.now();
        const response = await axios.post(config.nvidia.apiUrl, body, {
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${config.nvidia.apiKey}`
            },
            timeout: config.nvidia.timeoutMs
        });

        const elapsed = Date.now() - t0;
        console.log(`[NVIDIA] Text responded in ${elapsed}ms — status: ${response.status}`);

        const rawData = response.data;
        const text = this._extractTextContent(rawData);

        if (!text || !text.trim()) {
            throw new Error('NVIDIA returned empty text response');
        }

        // Strip <think> blocks if reasoning model leaked them
        let cleaned = text.trim();
        if (cleaned.includes('</think>')) {
            cleaned = cleaned.substring(cleaned.lastIndexOf('</think>') + 8).trim();
        }
        if (cleaned.includes('<|/think|>')) {
            cleaned = cleaned.substring(cleaned.lastIndexOf('<|/think|>') + 10).trim();
        }
        // Strip markdown code fences
        cleaned = cleaned.replace(/```[\s\S]*?```/g, '').trim();

        console.log(`[NVIDIA] Text extracted (${cleaned.length} chars)`);
        return cleaned;
    }

    /**
     * Extract plain text from API response — no SQL validation.
     * Prefers message.content; falls back to reasoning if content is empty/non-sensical.
     */
    _extractTextContent(data) {
        const choices = data.choices;
        if (!choices || !choices.length) throw new Error('Invalid API response: no choices');

        const message = choices[0].message;
        if (!message) throw new Error('No message in API response');

        // Prefer content if present and non-trivial
        if (message.content && message.content !== 'null' && message.content.trim().length > 10) {
            return message.content;
        }

        // Fall back to reasoning field
        const reasoning = message.reasoning || message.reasoning_content;
        if (reasoning && reasoning.trim().length > 10) {
            return reasoning;
        }

        // Last resort: raw content even if short
        return message.content || '';
    }

    /**
     * Check if NVIDIA API is reachable.
     */
    async isAvailable() {
        try {
            if (!config.nvidia.apiKey) return false;
            await axios.get(config.nvidia.apiUrl.replace('/chat/completions', '/models'), {
                headers: { 'Authorization': `Bearer ${config.nvidia.apiKey}` },
                timeout: 5000
            });
            return true;
        } catch (e) {
            // Assume available if key exists — health endpoint may 404
            return !!config.nvidia.apiKey;
        }
    }

    getProviderName() { return 'NVIDIA NIM'; }
}

module.exports = new NvidiaLlmService();
