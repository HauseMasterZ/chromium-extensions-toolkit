// A lightweight port of the ClearURLs engine.
function cleanUrlWithClearUrls(url, rulesData) {
    if (!rulesData || !rulesData.providers) return url;
    
    let urlObj;
    try {
        urlObj = new URL(url);
    } catch(e) { return url; }

    let finalUrl = url;
    let providers = rulesData.providers;

    for (let key in providers) {
        let provider = providers[key];
        
        // 1. Match URL Pattern
        if (provider.urlPattern) {
            let regex = new RegExp(provider.urlPattern, "i");
            if (!regex.test(finalUrl)) continue;
        }

        // 2. Match Exceptions
        let isException = false;
        if (provider.exceptions) {
            for (let exception of provider.exceptions) {
                if (new RegExp(exception, "i").test(finalUrl)) {
                    isException = true;
                    break;
                }
            }
        }
        if (isException) continue;

        // 3. Apply Raw Rules (Regex replacements on the whole URL string)
        if (provider.rawRules) {
            for (let rawRule of provider.rawRules) {
                finalUrl = finalUrl.replace(new RegExp(rawRule, "gi"), "");
            }
            try { urlObj = new URL(finalUrl); } catch(e) { return finalUrl; }
        }

        // 4. Apply Parameter Rules (Delete matching search params)
        let searchParams = urlObj.searchParams;
        let rules = provider.rules || [];
        
        // Include referral marketing rules to aggressively strip affiliate tags
        if (provider.referralMarketing) {
            rules = rules.concat(provider.referralMarketing);
        }

        if (rules.length > 0) {
            let keysToDelete = [];
            for (let param of searchParams.keys()) {
                for (let rule of rules) {
                    if (new RegExp("^" + rule + "$", "gi").test(param)) {
                        keysToDelete.push(param);
                        break;
                    }
                }
            }
            keysToDelete.forEach(k => searchParams.delete(k));
        }

        urlObj.search = searchParams.toString();
        finalUrl = urlObj.toString();
    }

    // Fix trailing ? if search string is empty
    return finalUrl.replace(/\?$/, '');
}
