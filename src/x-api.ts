import { TwitterApi } from 'twitter-api-v2';
import { logger } from './logger.js';

export async function postToX(content: string): Promise<string> {
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
    logger.error({ err: error.message }, 'Error posting to X');
    throw new Error('Failed to post to X: ' + error.message);
  }
}
