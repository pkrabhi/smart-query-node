const BLOCKED_KEYWORDS = [
    'INSERT ', 'UPDATE ', 'DELETE ', 'DROP ', 'ALTER ', 'TRUNCATE ',
    'CREATE ', 'GRANT ', 'REVOKE ', 'EXEC ', 'EXECUTE ', 'CALL ',
    'COPY ', '\\COPY', 'pg_', 'information_schema'
];

class SqlValidator {

    /**
     * Validate SQL — only SELECT/WITH allowed, no dangerous keywords.
     */
    validate(sql) {
        if (!sql || !sql.trim()) {
            console.warn('[SqlValidator] Empty SQL');
            return { valid: false, reason: 'Empty SQL' };
        }

        const upper = sql.toUpperCase().trim();

        if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
            console.warn(`[SqlValidator] Not a SELECT. Starts with: ${upper.substring(0, 20)}`);
            return { valid: false, reason: 'Only SELECT queries are allowed.' };
        }

        for (const keyword of BLOCKED_KEYWORDS) {
            if (upper.includes(keyword.toUpperCase())) {
                console.warn(`[SqlValidator] Blocked keyword: ${keyword.trim()}`);
                return { valid: false, reason: `Blocked keyword detected: ${keyword.trim()}` };
            }
        }

        // Check multiple statements
        const noStrings = sql.replace(/'[^']*'/g, '');
        const semiIdx = noStrings.indexOf(';');
        if (semiIdx >= 0 && semiIdx < noStrings.length - 1) {
            console.warn('[SqlValidator] Multiple statements detected');
            return { valid: false, reason: 'Multiple statements not allowed.' };
        }

        console.log('[SqlValidator] Validation passed');
        return { valid: true };
    }

    /**
     * Enforce LIMIT clause.
     */
    enforceLimits(sql, maxRows) {
        const upper = sql.toUpperCase();
        if (!upper.includes('LIMIT')) {
            sql = sql.trim() + ' LIMIT ' + maxRows;
            console.log(`[SqlValidator] Added LIMIT ${maxRows}`);
        } else {
            const match = sql.match(/LIMIT\s+(\d+)/i);
            if (match && parseInt(match[1]) > maxRows) {
                sql = sql.replace(/LIMIT\s+\d+/i, 'LIMIT ' + maxRows);
                console.log(`[SqlValidator] Reduced LIMIT to ${maxRows}`);
            }
        }
        return sql;
    }

    /**
     * Fix PostgreSQL :: casts for compatibility.
     * )::type → remove cast (function results don't need it)
     * identifier::type → CAST(identifier AS type)
     */
    fixPostgreCasts(sql) {
        if (!sql || !sql.includes('::')) return sql;

        const original = sql;
        const typePattern = '(date|int|integer|bigint|numeric|text|varchar|float|double precision|boolean|timestamp)';
        const typeRegex = new RegExp('::'+ typePattern, 'gi');

        // Case 1: )::type → just remove
        sql = sql.replace(new RegExp('\\)::' + typePattern, 'gi'), ')');

        // Case 2: identifier::type → CAST(identifier AS type)
        const castRegex = new RegExp('([a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)?)::' + typePattern, 'gi');
        let count = 0;
        sql = sql.replace(castRegex, (match, expr, type) => {
            count++;
            return `CAST(${expr} AS ${type})`;
        });

        // Safety: strip any remaining ::type
        if (sql.includes('::')) {
            sql = sql.replace(typeRegex, '');
        }

        if (sql !== original) {
            console.log(`[SqlValidator] Fixed :: casts → CAST() (${count}x CAST, rest stripped)`);
        }
        return sql;
    }
}

module.exports = new SqlValidator();
