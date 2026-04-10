/**
 * Web search and fetch tools.
 * Gives agents the ability to search the web and read web pages.
 */

const DEFAULT_USER_AGENT = 'AaaS-Agent/1.0';
const MAX_CONTENT_LENGTH = 8000; // characters returned to LLM

/**
 * Search the web using a configurable provider.
 * Supported providers: serper (default), brave.
 */
export async function webSearch(config, { query, num_results = 5 }) {
  if (!query) return JSON.stringify({ error: 'query is required.' });

  const provider = config?.web_search?.provider || 'serper';
  const apiKey = config?.web_search?.api_key;

  if (!apiKey) {
    return JSON.stringify({
      error: `Web search requires an API key. Set web_search.provider and web_search.api_key in .aaas/config.json. Supported providers: serper (serper.dev), brave (brave.com/search/api/).`,
    });
  }

  try {
    let results;
    if (provider === 'brave') {
      results = await searchBrave(apiKey, query, num_results);
    } else {
      results = await searchSerper(apiKey, query, num_results);
    }
    return JSON.stringify({ query, results });
  } catch (err) {
    return JSON.stringify({ error: `Web search failed: ${err.message}` });
  }
}

async function searchSerper(apiKey, query, num) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num }),
  });
  if (!res.ok) throw new Error(`Serper API returned ${res.status}`);
  const data = await res.json();
  const organic = data.organic || [];
  return organic.slice(0, num).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
  }));
}

async function searchBrave(apiKey, query, num) {
  const params = new URLSearchParams({ q: query, count: String(num) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
  });
  if (!res.ok) throw new Error(`Brave API returned ${res.status}`);
  const data = await res.json();
  const results = data.web?.results || [];
  return results.slice(0, num).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

/**
 * Fetch a URL and return its text content.
 * Strips HTML tags and collapses whitespace for readability.
 */
export async function webFetch({ url, extract = 'text' }) {
  if (!url) return JSON.stringify({ error: 'url is required.' });

  // Basic URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return JSON.stringify({ error: 'url must start with http:// or https://' });
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/json,text/plain,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText}`, url });
    }

    const contentType = res.headers.get('content-type') || '';

    // JSON responses — return as-is (truncated)
    if (contentType.includes('application/json')) {
      const text = await res.text();
      const truncated = text.slice(0, MAX_CONTENT_LENGTH);
      return JSON.stringify({
        url,
        type: 'json',
        content: truncated,
        truncated: text.length > MAX_CONTENT_LENGTH,
      });
    }

    // HTML — strip to text
    if (contentType.includes('text/html')) {
      const html = await res.text();
      const text = htmlToText(html);
      const truncated = text.slice(0, MAX_CONTENT_LENGTH);
      return JSON.stringify({
        url,
        type: 'text',
        content: truncated,
        truncated: text.length > MAX_CONTENT_LENGTH,
      });
    }

    // Plain text
    const text = await res.text();
    const truncated = text.slice(0, MAX_CONTENT_LENGTH);
    return JSON.stringify({
      url,
      type: 'text',
      content: truncated,
      truncated: text.length > MAX_CONTENT_LENGTH,
    });
  } catch (err) {
    return JSON.stringify({ error: `Fetch failed: ${err.message}`, url });
  }
}

/**
 * Strip HTML to readable text.
 * Removes scripts, styles, tags, and collapses whitespace.
 */
function htmlToText(html) {
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Convert block elements to newlines
  text = text.replace(/<\/?(?:div|p|br|hr|h[1-6]|li|tr|blockquote|section|article|header|footer|nav|main|aside)\b[^>]*>/gi, '\n');
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  return text.trim();
}
