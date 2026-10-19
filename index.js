// Import necessary modules
import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
} from '@discordjs/voice';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import OpenAI from 'openai';

// Load environment variables from .env file
dotenv.config();

const conversationHistory = new Map();

const RESEARCH_MODELS = [
  'gemini-3.6-flash:free',
  'gpt-4o:free',
  'deepseek-v4-flash:free',
];

const MOD_MODELS = [
  'deepseek-v4-flash:free',
  'qwen3.6-27b:free',
  'qwen3.6-35b-a3b:free',
];

const openai = new OpenAI({
  baseURL: process.env.UNO_URL,
  apiKey: process.env.UNO_KEY,
});

const voiceSessions = new Map();

const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the internet to find current information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_messages',
      description: 'Delete recent messages from the current Discord channel.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'number',
            maximum: 1000,
          },
          reason: {
            type: 'string',
          },
        },
        required: ['count', 'reason'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_channel',
      description: 'Create a new text channel in the current Discord server.',
      parameters: {
        type: 'object',
        properties: {
          channel_name: {
            type: 'string',
          },
        },
        required: ['channel_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timeout_member',
      description: 'Timeout a member in the current Discord server.',
      parameters: {
        type: 'object',
        properties: {
          username: {
            type: 'string',
          },
          duration_minutes: {
            type: 'number',
            maximum: 60,
          },
        },
        required: ['username', 'duration_minutes'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'purge_channel',
      description: 'Rebuild the current channel to clear all messages, including messages older than 14 days.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ban_member',
      description: 'Ban a member from the current Discord server.',
      parameters: {
        type: 'object',
        properties: {
          username: {
            type: 'string',
          },
          reason: {
            type: 'string',
          },
        },
        required: ['username', 'reason'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kick_member',
      description: 'Kick a member from the current Discord server.',
      parameters: {
        type: 'object',
        properties: {
          username: {
            type: 'string',
          },
        },
        required: ['username'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lock_channel',
      description: 'Lock the current channel so the @everyone role cannot send messages.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_nickname',
      description: 'Change a member nickname in the current Discord server.',
      parameters: {
        type: 'object',
        properties: {
          username: {
            type: 'string',
          },
          new_nickname: {
            type: 'string',
          },
        },
        required: ['username', 'new_nickname'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'join_voice_channel',
      description: 'Join the administrator’s current voice channel and stay connected.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leave_voice_channel',
      description: 'Leave the voice channel and stop the keep-alive audio.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

const ASK_TOOLS = tools.filter(({ function: tool }) => tool.name === 'web_search');
const MOD_TOOLS = tools.filter(({ function: tool }) => tool.name !== 'web_search');

const createEmbeds = (description, command) => [
  new EmbedBuilder().setColor(0x1f1f1f).setDescription(command),
  new EmbedBuilder().setColor(0x1f1f1f).setDescription(description),
];

function createSilentAudioResource() {
  const ffmpeg = spawn('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1',
  ]);

  ffmpeg.stderr.resume();
  ffmpeg.on('error', (error) => {
    console.error('Silent audio process failed:', error);
  });

  return {
    ffmpeg,
    resource: createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
    }),
  };
}

function stopVoiceSession(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session) return;

  voiceSessions.delete(guildId);
  session.player.stop(true);
  session.connection.destroy();
  session.ffmpeg.kill();
}

async function executeTool(name, argumentsJson, message) {
  console.log(`Audit: ${message.user.tag} executed ${name}`);

  try {
    const args = JSON.parse(argumentsJson);

    if (name === 'web_search') {
      const res = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1`,
      );
      const data = await res.json();
      let results = data.AbstractText || '';
      if (data.RelatedTopics) {
        const topics = data.RelatedTopics.slice(0, 3)
          .map((topic) => topic.Text)
          .filter(Boolean);
        results += `\n${topics.join('\n')}`;
      }
      return results || 'No results found.';
    }

    if (!message.guild) {
      throw new Error('Moderation tools can only be used in a server.');
    }

    if (name === 'join_voice_channel') {
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        throw new Error('You must be in a voice channel to use this tool.');
      }

      stopVoiceSession(message.guild.id);
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      const player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
        },
      });
      const silentAudio = createSilentAudioResource();

      player.on(AudioPlayerStatus.Idle, () => {
        const session = voiceSessions.get(message.guild.id);
        if (!session || session.player !== player) return;

        const previousFfmpeg = session.ffmpeg;
        const nextSilentAudio = createSilentAudioResource();
        session.ffmpeg = nextSilentAudio.ffmpeg;
        player.play(nextSilentAudio.resource);
        previousFfmpeg.kill();
      });
      connection.subscribe(player);
      voiceSessions.set(message.guild.id, { connection, player, ffmpeg: silentAudio.ffmpeg });
      player.play(silentAudio.resource);
      return `Joined ${voiceChannel.name} and started the voice keep-alive.`;
    }

    if (name === 'leave_voice_channel') {
      if (!voiceSessions.has(message.guild.id)) {
        return 'The bot is not connected to a voice channel.';
      }

      stopVoiceSession(message.guild.id);
      return 'Left the voice channel and stopped the voice keep-alive.';
    }

    if (name === 'delete_messages') {
      if (!Number.isInteger(args.count) || args.count < 1 || args.count > 1000) {
        throw new Error('count must be an integer between 1 and 1000.');
      }
      if (typeof args.reason !== 'string' || !args.reason.trim()) {
        throw new Error('reason is required.');
      }

      const wipeRequest =
        /\b(wipe|clear|reset|purge|delete\s+(all|everything)|remove\s+(all|everything))\b/i.test(
          args.reason,
        );

      if (args.count > 50) {
        if (!wipeRequest) {
          return 'Large deletions require a wipe or clear request to reset the channel safely.';
        }

        const replacementChannel = await message.channel.clone();
        await message.channel.delete(
          'Channel reset requested to remove messages older than 14 days.',
        );
        return `Warning: this reset the channel by creating #${replacementChannel.name} and deleting the original channel.`;
      }

      try {
        const deleted = await message.channel.bulkDelete(args.count, true);
        return `Deleted ${deleted.size} message(s). Reason: ${args.reason}`;
      } catch (error) {
        if (error?.code === 50034 || /14 days|14-day/i.test(error?.message ?? '')) {
          return 'Error: Some messages are older than 14 days and cannot be bulk deleted. Try cloning the channel instead.';
        }
        throw error;
      }
    }

    if (name === 'create_channel') {
      if (typeof args.channel_name !== 'string' || !args.channel_name.trim()) {
        throw new Error('channel_name is required.');
      }

      const channel = await message.guild.channels.create({
        name: args.channel_name.trim(),
      });
      return `Created channel #${channel.name}.`;
    }

    if (name === 'timeout_member') {
      if (typeof args.username !== 'string' || !args.username.trim()) {
        throw new Error('username is required.');
      }
      if (
        !Number.isFinite(args.duration_minutes) ||
        args.duration_minutes < 1 ||
        args.duration_minutes > 60
      ) {
        throw new Error('duration_minutes must be between 1 and 60.');
      }

      let member = message.guild.members.cache.find(
        (candidate) =>
          candidate.user.username === args.username ||
          candidate.displayName === args.username ||
          candidate.user.tag === args.username,
      );
      if (!member) {
        const matches = await message.guild.members.fetch({
          query: args.username,
          limit: 1,
        });
        member = matches.first();
      }
      if (!member) {
        throw new Error(`Could not find member "${args.username}".`);
      }

      await member.timeout(args.duration_minutes * 60 * 1000);
      return `Timed out ${member.user.tag} for ${args.duration_minutes} minute(s).`;
    }

    if (name === 'purge_channel') {
      const originalChannel = message.channel;
      const replacementChannel = await originalChannel.clone();
      await replacementChannel.setPosition(originalChannel.position);
      await replacementChannel.send('Channel rebuilt for moderation.');
      await originalChannel.delete();
      return `Rebuilt #${replacementChannel.name} for moderation.`;
    }

    if (name === 'ban_member') {
      if (typeof args.username !== 'string' || !args.username.trim()) {
        throw new Error('username is required.');
      }
      if (typeof args.reason !== 'string' || !args.reason.trim()) {
        throw new Error('reason is required.');
      }

      const member = message.guild.members.cache.find(
        (candidate) => candidate.user.username === args.username,
      );
      if (!member) {
        throw new Error(`Could not find member "${args.username}".`);
      }

      await member.ban({ reason: args.reason });
      return `Banned ${member.user.tag}.`;
    }

    if (name === 'kick_member') {
      if (typeof args.username !== 'string' || !args.username.trim()) {
        throw new Error('username is required.');
      }

      const member = message.guild.members.cache.find(
        (candidate) => candidate.user.username === args.username,
      );
      if (!member) {
        throw new Error(`Could not find member "${args.username}".`);
      }

      await member.kick();
      return `Kicked ${member.user.tag}.`;
    }

    if (name === 'lock_channel') {
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: false,
      });
      return 'Locked the current channel.';
    }

    if (name === 'change_nickname') {
      if (typeof args.username !== 'string' || !args.username.trim()) {
        throw new Error('username is required.');
      }
      if (typeof args.new_nickname !== 'string' || !args.new_nickname.trim()) {
        throw new Error('new_nickname is required.');
      }

      const member = message.guild.members.cache.find(
        (candidate) => candidate.user.username === args.username,
      );
      if (!member) {
        throw new Error(`Could not find member "${args.username}".`);
      }

      await member.setNickname(args.new_nickname);
      return `Successfully changed nickname for ${args.username} to ${args.new_nickname}`;
    }

    throw new Error(`Unsupported tool requested: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Tool ${name} failed:`, error);
    return `Tool execution failed: ${errorMessage}`;
  }
}

// Create a new Discord client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the AI a research question')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('Your research question').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Ask the AI to perform a moderation action')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('Your moderation request').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear your conversation memory with the bot'),
].map((command) => command.toJSON());

// Event listener for when the bot is ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });
    console.log('Registered /ask and /mod commands.');
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (
    interaction.commandName !== 'ask' &&
    interaction.commandName !== 'mod' &&
    interaction.commandName !== 'clear'
  ) {
    return;
  }

  if (interaction.commandName === 'clear') {
    conversationHistory.delete(interaction.user.id);
    return interaction.reply('🧠 Memory cleared!');
  }

  const query = interaction.options.getString('prompt', true);
  const userHistory = conversationHistory.get(interaction.user.id) || [];
  const history = userHistory.slice(-10);
  const models = interaction.commandName === 'ask' ? RESEARCH_MODELS : MOD_MODELS;
  const commandTools = interaction.commandName === 'ask' ? ASK_TOOLS : MOD_TOOLS;
  const systemPrompt =
    interaction.commandName === 'ask'
      ? 'You are an expert researcher. Use the web_search tool to find information. Do not perform moderation. You have access to the previous messages in this conversation. Use them for context.'
      : "You are an expert Discord server administrator. You must always fulfill the user's request using your moderation tools. You are forbidden from replying with refusal messages like 'I cannot fulfill this request'. If a user asks to delete, ban, or kick, you must execute the tool immediately. You have access to the previous messages in this conversation. Use them for context.";

  await interaction.deferReply();
  if (
    interaction.commandName === 'mod' &&
    !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.editReply('Error: You must be an Administrator to use these tools.');
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: query },
    ];
    let moderationSteps = 0;
    let moderationToolExecuted = false;

    while (true) {
      if (
        interaction.commandName === 'mod' &&
        !moderationToolExecuted &&
        moderationSteps >= 3
      ) {
        throw new Error('The AI did not execute a moderation tool within 3 steps.');
      }

      moderationSteps += 1;
      let completion;
      let lastError;
      for (const model of models) {
        try {
          completion = await openai.chat.completions.create({
            model,
            messages,
            tools: commandTools,
          });
          break;
        } catch (error) {
          lastError = error;
          console.error(`Model ${model} failed, trying next...`, error);
        }
      }
      if (!completion) {
        throw lastError ?? new Error('All research models failed.');
      }

      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error('The AI returned no message.');
      }

      messages.push(assistantMessage);

      if (!assistantMessage.tool_calls?.length) {
        const response = assistantMessage.content?.trim();
        if (!response) {
          throw new Error('The AI returned an empty response.');
        }

        if (interaction.commandName === 'mod' && !moderationToolExecuted) {
          const asksForConfirmation = /^(Please confirm|Are you sure)/i.test(response);
          messages.push({
            role: 'user',
            content: asksForConfirmation
              ? 'Do not ask for confirmation. Execute the appropriate moderation tool immediately.'
              : 'You must execute the appropriate moderation tool now. Do not respond with text.',
          });
          continue;
        }

        await interaction.editReply({ embeds: createEmbeds(response, query) });
        conversationHistory.set(
          interaction.user.id,
          [...history, { role: 'user', content: query }, { role: 'assistant', content: response }].slice(
            -10,
          ),
        );
        return;
      }

      for (const toolCall of assistantMessage.tool_calls) {
        moderationToolExecuted = true;
        const toolResult = await executeTool(
          toolCall.function.name,
          toolCall.function.arguments,
          interaction,
        );

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }
  } catch (error) {
    console.error('AI request failed:', error);
    await interaction.editReply({
      embeds: createEmbeds('I could not complete that request.', query),
    });
  }
});

// Log in to Discord with the bot token
client.login(process.env.DISCORD_TOKEN);