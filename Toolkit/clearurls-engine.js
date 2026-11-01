// A lightweight, hyper-optimized port of the ClearURLs engine.
const _compiledProviderCache = new WeakMap();
const _regexCache = new Map();
const REGEX_METACHAR_PATTERN = /[\^$.*+?()[\]{}|\\]/;

function _getCompiledRegex(pattern, flags = 'i') {
    const key = `${flags}:${pattern}`;
    let rx = _regexCache.get(key);
    if (!rx) {
        try {
            rx = new RegExp(pattern, flags);
            if (_regexCache.size > 2000) {
                _regexCache.delete(_regexCache.keys().next().value);
            }
            _regexCache.set(key, rx);
        } catch {
            return null;
        }
    }
    return rx;
}

function cleanUrlWithClearUrls(url, rulesData) {
    if (!rulesData || !rulesData.providers || !url) return url;

    const hasQuestion = url.includes('?');

    let urlObj;
    try {
        urlObj = new URL(url);
    } catch {
        return url;
    }

    let finalUrl = url;
    const providers = rulesData.providers;

    // Cache pre-compiled provider metadata on rulesData to avoid rebuilding regexes on every call
    let compiledProviders = _compiledProviderCache.get(rulesData);
    if (!compiledProviders) {
        compiledProviders = [];
        const rawOnly = [];
        for (const key in providers) {
            const p = providers[key];
            const urlRx = p.urlPattern ? _getCompiledRegex(p.urlPattern, 'i') : null;
            const exRxs = Array.isArray(p.exceptions) ? p.exceptions.map(e => _getCompiledRegex(e, 'i')).filter(Boolean) : [];
            const rawRxs = Array.isArray(p.rawRules) ? p.rawRules.map(r => _getCompiledRegex(r, 'gi')).filter(Boolean) : [];

            let allRules = p.rules || [];
            if (p.referralMarketing) {
                allRules = allRules.concat(p.referralMarketing);
            }

            const exactParams = new Set();
            const regexParams = [];
            for (let i = 0; i < allRules.length; i++) {
                const r = allRules[i];
                if (!REGEX_METACHAR_PATTERN.test(r)) {
                    exactParams.add(r.toLowerCase());
                } else {
                    const rx = _getCompiledRegex(`^${r}$`, 'i');
                    if (rx) regexParams.push(rx);
                }
            }

            const cp = {
                urlPattern: urlRx,
                exceptions: exRxs,
                rawRules: rawRxs,
                exactParams: exactParams,
                regexParams: regexParams
            };
            compiledProviders.push(cp);
            if (rawRxs.length > 0) {
                rawOnly.push(cp);
            }
        }
        compiledProviders.rawOnly = rawOnly;
        _compiledProviderCache.set(rulesData, compiledProviders);
    }

    let hasParams = hasQuestion && urlObj.search.length > 1;
    const candidateList = hasParams ? compiledProviders : compiledProviders.rawOnly;

    for (let i = 0; i < candidateList.length; i++) {
        const cp = candidateList[i];

        if (!hasParams && cp.rawRules.length === 0) continue;

        // 1. Match URL Pattern
        if (cp.urlPattern && !cp.urlPattern.test(finalUrl)) continue;

        // 2. Match Exceptions
        let isException = false;
        for (let j = 0; j < cp.exceptions.length; j++) {
            if (cp.exceptions[j].test(finalUrl)) {
                isException = true;
                break;
            }
        }
        if (isException) continue;

        // 3. Apply Raw Rules
        if (cp.rawRules.length > 0) {
            let modified = false;
            for (let j = 0; j < cp.rawRules.length; j++) {
                const replaced = finalUrl.replace(cp.rawRules[j], '');
                if (replaced !== finalUrl) {
                    finalUrl = replaced;
                    modified = true;
                }
            }
            if (modified) {
                try {
                    urlObj = new URL(finalUrl);
                    hasParams = finalUrl.includes('?') && urlObj.search.length > 1;
                } catch {
                    return finalUrl;
                }
            }
        }

        // 4. Apply Parameter Rules
        if (hasParams && (cp.exactParams.size > 0 || cp.regexParams.length > 0)) {
            const searchParams = urlObj.searchParams;
            const keysToDelete = new Set();
            for (const param of searchParams.keys()) {
                const lower = param.toLowerCase();
                if (cp.exactParams.has(lower)) {
                    keysToDelete.add(param);
                    continue;
                }
                for (let j = 0; j < cp.regexParams.length; j++) {
                    if (cp.regexParams[j].test(param)) {
                        keysToDelete.add(param);
                        break;
                    }
                }
            }
            if (keysToDelete.size > 0) {
                for (const param of keysToDelete) {
                    searchParams.delete(param);
                }
                urlObj.search = searchParams.toString();
                finalUrl = urlObj.toString();
                hasParams = finalUrl.includes('?') && urlObj.search.length > 1;
            }
        }
    }

    // Fix trailing ? if search string is empty (at end of URL or before fragment #)
    return finalUrl.replace(/\?(?=#|$)/, '');
}
