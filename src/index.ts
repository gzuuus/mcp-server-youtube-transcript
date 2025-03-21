#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getSubtitles } from 'youtube-captions-scraper';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Configuration
const CONFIG = {
  maxRetries: 3,
  retryBaseDelay: 1000, // ms
  cacheDir: path.join(os.tmpdir(), 'youtube-transcript-cache'),
  cacheTTL: 24 * 60 * 60 * 1000, // 24 hours in ms
  proxyUrl: process.env.HTTP_PROXY || process.env.HTTPS_PROXY,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

interface TranscriptLine {
  text: string;
  start: number;
  dur: number;
}

interface CachedTranscript {
  transcript: string;
  timestamp: number;
}

class YouTubeTranscriptExtractor {
  private cacheInitialized = false;

  /**
   * Initialize cache directory
   */
  private async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return;

    try {
      await fs.mkdir(CONFIG.cacheDir, { recursive: true });
      this.cacheInitialized = true;
    } catch (error) {
      console.error('Failed to initialize cache directory:', error);
      // Continue without caching if directory creation fails
    }
  }

  /**
   * Get cached transcript if available and not expired
   */
  private async getCachedTranscript(videoId: string, lang: string): Promise<string | null> {
    await this.initializeCache();

    const cacheFilePath = path.join(CONFIG.cacheDir, `${videoId}_${lang}.json`);

    try {
      const fileContent = await fs.readFile(cacheFilePath, 'utf-8');
      const cachedData = JSON.parse(fileContent) as CachedTranscript;

      // Check if cache is still valid
      if (Date.now() - cachedData.timestamp < CONFIG.cacheTTL) {
        console.error(`Using cached transcript for video ${videoId} (${lang})`);
        return cachedData.transcript;
      }

      // Cache expired, delete it
      await fs.unlink(cacheFilePath);
      return null;
    } catch (error) {
      return null; // File doesn't exist or can't be read
    }
  }

  /**
   * Cache transcript for future use
   */
  private async cacheTranscript(videoId: string, lang: string, transcript: string): Promise<void> {
    await this.initializeCache();

    const cacheFilePath = path.join(CONFIG.cacheDir, `${videoId}_${lang}.json`);

    try {
      const cacheData: CachedTranscript = {
        transcript,
        timestamp: Date.now(),
      };

      await fs.writeFile(cacheFilePath, JSON.stringify(cacheData));
    } catch (error) {
      console.error('Failed to cache transcript:', error);
      // Continue without caching if write fails
    }
  }

  /**
   * Extracts YouTube video ID from various URL formats or direct ID input
   */
  extractYoutubeId(input: string): string {
    if (!input) {
      throw new McpError(ErrorCode.InvalidParams, 'YouTube URL or ID is required');
    }

    // Handle URL formats
    try {
      const url = new URL(input);
      if (url.hostname === 'youtu.be') {
        return url.pathname.slice(1).split('?')[0]; // Handle extra params
      } else if (url.hostname.includes('youtube.com')) {
        const videoId = url.searchParams.get('v');
        if (!videoId) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid YouTube URL: ${input}`);
        }
        return videoId;
      }
    } catch (error) {
      // Not a URL, check if it's a direct video ID
      if (!/^[a-zA-Z0-9_-]{11}$/.test(input)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid YouTube video ID: ${input}`);
      }
      return input;
    }

    throw new McpError(ErrorCode.InvalidParams, `Could not extract video ID from: ${input}`);
  }

  /**
   * Retrieves transcript for a given video ID and language with retries
   */
  async getTranscript(videoId: string, lang: string): Promise<string> {
    // Check cache first
    const cachedTranscript = await this.getCachedTranscript(videoId, lang);
    if (cachedTranscript) {
      return cachedTranscript;
    }

    let lastError: Error | null = null;

    // Try primary method with retries
    for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = CONFIG.retryBaseDelay * Math.pow(2, attempt - 1);
          console.error(`Retry attempt ${attempt + 1}/${CONFIG.maxRetries} after ${delay}ms delay`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const transcript = await this.fetchTranscriptWithCaptionsScraper(videoId, lang);

        // Cache the successful result
        await this.cacheTranscript(videoId, lang, transcript);

        return transcript;
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        lastError = error as Error;

        // If it's not a rate limit or network error, don't retry
        if (error instanceof McpError && error.code !== ErrorCode.InternalError) {
          throw error;
        }
      }
    }

    // If primary method failed, try fallback method
    try {
      console.error('Trying fallback method to fetch transcript');
      const transcript = await this.fetchTranscriptWithFallbackMethod(videoId, lang);

      // Cache the successful result
      await this.cacheTranscript(videoId, lang, transcript);

      return transcript;
    } catch (fallbackError) {
      console.error('Fallback method failed:', fallbackError);

      // If we got here, all methods failed
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve transcript after multiple attempts: ${lastError?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Primary method to fetch transcript using youtube-captions-scraper
   */
  private async fetchTranscriptWithCaptionsScraper(videoId: string, lang: string): Promise<string> {
    try {
      const options: any = {
        videoID: videoId,
        lang: lang,
      };

      // Add proxy support if configured
      if (CONFIG.proxyUrl) {
        options.requestOptions = {
          agent: new HttpsProxyAgent(CONFIG.proxyUrl),
          headers: {
            'User-Agent': CONFIG.userAgent,
          },
        };
      }

      const transcript = await getSubtitles(options);
      return this.formatTranscript(transcript);
    } catch (error) {
      console.error('Failed with primary transcript method:', error);

      // Check for specific errors that might indicate IP blocking
      const errorMsg = (error as Error).message || '';
      if (
        errorMsg.includes('429') ||
        errorMsg.includes('too many requests') ||
        errorMsg.includes('blocked') ||
        errorMsg.includes('forbidden')
      ) {
        throw new McpError(
          ErrorCode.InternalError,
          `YouTube might be rate limiting or blocking this IP: ${errorMsg}`
        );
      }

      throw new McpError(ErrorCode.InternalError, `Primary transcript method failed: ${errorMsg}`);
    }
  }

  /**
   * Fallback method using a different approach to fetch transcripts
   */
  private async fetchTranscriptWithFallbackMethod(videoId: string, lang: string): Promise<string> {
    try {
      // YouTube's transcript API endpoint (this is a simplified example)
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}`;

      const options: any = {
        headers: {
          'User-Agent': CONFIG.userAgent,
        },
      };

      if (CONFIG.proxyUrl) {
        options.agent = new HttpsProxyAgent(CONFIG.proxyUrl);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const xml = await response.text();

      // Basic XML parsing for transcript (in a real implementation, use a proper XML parser)
      const lines = xml.match(/<text[^>]*>(.*?)<\/text>/g) || [];
      const textContent = lines.map(line => {
        const content = line.replace(/<[^>]*>/g, '').trim();
        return content
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      });

      return textContent.join(' ');
    } catch (error) {
      console.error('Failed with fallback transcript method:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Fallback transcript method failed: ${(error as Error).message}`
      );
    }
  }

  /**
   * Formats transcript lines into readable text
   */
  private formatTranscript(transcript: TranscriptLine[]): string {
    return transcript
      .map(line => line.text.trim())
      .filter(text => text.length > 0)
      .join(' ');
  }
}

async function main() {
  const extractor = new YouTubeTranscriptExtractor();

  const server = new McpServer({
    name: 'youtube-transcript-extractor',
    version: '0.1.0',
  });

  process.on('SIGINT', async () => {
    try {
      await server.close();
    } catch (error) {
      console.error('Error while stopping server:', error);
    }
    process.exit(0);
  });

  server.tool(
    'get_transcript',
    'Extract transcript from a YouTube video URL or ID',
    {
      url: z.string().describe('YouTube video URL or ID'),
      lang: z.string().default('en').describe('Language code for transcript (e.g., "ko", "en")'),
    },
    async ({ url, lang }) => {
      console.error(`Processing transcript request for: ${url}, language: ${lang}`);

      try {
        const videoId = extractor.extractYoutubeId(url);
        console.error(`Successfully extracted video ID: ${videoId}`);

        const transcript = await extractor.getTranscript(videoId, lang);
        console.error(`Successfully extracted transcript (${transcript.length} chars)`);

        return {
          content: [
            {
              type: 'text' as const,
              text: transcript,
              metadata: {
                videoId,
                language: lang,
                timestamp: new Date().toISOString(),
                charCount: transcript.length,
              },
            },
          ],
        };
      } catch (error) {
        console.error('Transcript extraction failed:', error);

        if (error instanceof McpError) {
          throw error;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  console.error('Starting YouTube transcript extractor server...');
  await server.connect(transport);
}

main().catch(error => {
  console.error('Fatal server error:', error);
  process.exit(1);
});
