import { TwitterApi } from 'twitter-api-v2';
import { logger } from './logger.js';

export async function postToX(content: string): Promise<string> {
  if (content.length > 280) {
    logger.error({ length: content.length }, 'Tweet is too long for X');
    throw new Error(`Tweet exceeds 280 character limit (Current: ${content.length})`);
  }

  const client = new TwitterApi({
    appKey: process.env.X_APP_KEY || '',
    appSecret: process.env.X_APP_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessSecret: process.env.X_ACCESS_SECRET || '',
  });

  try {
    const rwClient = client.readWrite;
    const { data } = await rwClient.v2.tweet(content);
    logger.info({ x_tweet_id: data.id }, 'Successfully posted to X');
    return data.id;
  } catch (error: any) {
    // Log the full error data if available (this contains the 403 reason)
    const errorData = error.data || error;
    logger.error({ errorData, status: error.code }, 'Error posting to X');
    
    let message = error.message;
    if (errorData.detail) message += `: ${errorData.detail}`;
    
    throw new Error('Failed to post to X: ' + message);
  }
}
