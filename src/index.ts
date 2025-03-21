#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getSubtitles } from 'youtube-captions-scraper';

interface TranscriptLine {
  text: string;
  start: number;
  dur: number;
}

class YouTubeTranscriptExtractor {
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
        return url.pathname.slice(1);
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
   * Retrieves transcript for a given video ID and language
   */
  async getTranscript(videoId: string, lang: string): Promise<string> {
    try {
      const transcript = await getSubtitles({
        videoID: videoId,
        lang: lang,
      });

      return this.formatTranscript(transcript);
    } catch (error) {
      console.error('Failed to fetch transcript:', error);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to retrieve transcript: ${(error as Error).message}`
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
