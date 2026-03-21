const newsFeedControlBaseUrl = (process.env.NEWS_FEED_CONTROL_URL?.trim() || "http://127.0.0.1:3301").replace(/\/+$/, "");
const newsFeedControlToken = process.env.NEWS_FEED_CONTROL_TOKEN?.trim();

const requestNewsFeed = async (path: "/status" | "/poll" | "/pause" | "/resume", method: "GET" | "POST") => {
  const response = await fetch(`${newsFeedControlBaseUrl}${path}`, {
    method,
    headers: {
      ...(newsFeedControlToken ? { "X-NewsFeed-Token": newsFeedControlToken } : {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`news feed control request failed: ${response.status} ${response.statusText} ${text}`.trim());
  }

  return text.trim();
};

export const getNewsFeedStatus = async (): Promise<string> => requestNewsFeed("/status", "GET");
export const pollNewsFeedNow = async (): Promise<string> => requestNewsFeed("/poll", "POST");
export const pauseNewsFeed = async (): Promise<string> => requestNewsFeed("/pause", "POST");
export const resumeNewsFeed = async (): Promise<string> => requestNewsFeed("/resume", "POST");
