import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import {
  availableModelsFor,
  availableProviders,
  defaultModelFor,
  type AgentConfig
} from '../config.js';
import {Agent} from '../agent/Agent.js';
import type {
  AgentCallbacks,
  ApprovalDecision,
  ApprovalRequest
} from '../agent/types.js';
import type {ToolResult} from '../tools/types.js';
import type {ProviderName} from '../provider/types.js';
import {createProvider} from '../provider/registry.js';
import {createToolRegistry} from '../tools/registry.js';

type TranscriptItem = {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'approval' | 'error' | 'separator';
  title: string;
  text?: string;
  tone: 'cyan' | 'magenta' | 'green' | 'yellow' | 'red' | 'blue' | 'gray' | 'white';
  compact?: boolean;
};

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
};

type NavigationScreen = 'commands' | 'providers' | 'models';

type NavigationOption = {
  value: string;
  label: string;
  description: string;
  active?: boolean;
  hasChildren?: boolean;
};

const emptyUsage: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  requests: 0
};

const messageIndent = 3;
const transcriptHistoryLimit = 500;

export function App({config}: {config: AgentConfig}) {
  const [activeConfig, setActiveConfig] = useState(config);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [usage, setUsage] = useState<UsageTotals>(emptyUsage);
  const [showThinking, setShowThinking] = useState(false);
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [navigation, setNavigation] = useState<NavigationScreen | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const nextId = useRef(1);
  const activeAssistantId = useRef<number | null>(null);
  const {exit} = useApp();
  const {stdout} = useStdout();
  const viewportHeight = Math.max(1, (stdout.rows ?? 30) - 1);
  const viewportWidth = Math.max(40, stdout.columns ?? 80);
  const footerHeight = approval
    ? 10
    : navigation
      ? Math.min(12, navigationOptions(navigation).length + 4)
      : 3;
  const transcriptHeight = Math.max(4, viewportHeight - footerHeight - 7);
  const isAtTranscriptBottom = scrollOffset === 0;
  const visibleTranscript = useMemo(
    () =>
      selectVisibleTranscript(
        transcript,
        Math.max(1, transcriptHeight - (showThinking ? 1 : 0)),
        viewportWidth,
        Math.max(0, transcript.length - scrollOffset)
      ),
    [transcript, transcriptHeight, viewportWidth, showThinking, scrollOffset]
  );

  useEffect(() => {
    if (!showThinking || thinkingStartedAt === null) {
      return;
    }

    const timer = setInterval(() => {
      setThinkingSeconds(Math.floor((Date.now() - thinkingStartedAt) / 1000));
    }, 250);

    return () => {
      clearInterval(timer);
    };
  }, [showThinking, thinkingStartedAt]);

  useInput(
    (rawInput, key) => {
      const pageSize = Math.max(1, visibleTranscript.length - 1);
      const wheelDirection = parseMouseWheel(rawInput);

      if (wheelDirection === 'up') {
        setScrollOffset((current) =>
          Math.min(Math.max(0, transcript.length - 1), current + 1)
        );
        return;
      }

      if (wheelDirection === 'down') {
        setScrollOffset((current) => Math.max(0, current - 1));
        return;
      }

      if (key.pageUp) {
        setScrollOffset((current) =>
          Math.min(Math.max(0, transcript.length - 1), current + pageSize)
        );
        return;
      }

      if (key.pageDown) {
        setScrollOffset((current) => Math.max(0, current - pageSize));
        return;
      }

      if (key.home) {
        setScrollOffset(Math.max(0, transcript.length - 1));
        return;
      }

      if (key.end) {
        setScrollOffset(0);
      }
    },
    {isActive: !approval && !navigation && transcript.length > 0}
  );

  const agent = useMemo(() => {
    return new Agent({
      config: activeConfig,
      provider: createProvider(activeConfig),
      tools: createToolRegistry()
    });
  }, [activeConfig]);

  const addTranscript = (item: Omit<TranscriptItem, 'id'>): number => {
    const id = nextId.current++;
    setScrollOffset((current) =>
      current > 0 ? Math.min(current + 1, transcriptHistoryLimit - 1) : 0
    );
    setTranscript((items) => [...items, {...item, id}].slice(-transcriptHistoryLimit));
    return id;
  };

  const appendAssistantDelta = (delta: string) => {
    setShowThinking(false);
    if (activeAssistantId.current === null) {
      const id = nextId.current++;
      activeAssistantId.current = id;
      const nextItem: TranscriptItem = {
        id,
        kind: 'assistant',
        title: 'agent',
        text: delta,
        tone: 'white'
      };
      setScrollOffset((current) =>
        current > 0 ? Math.min(current + 1, transcriptHistoryLimit - 1) : 0
      );
      setTranscript((items) => [
        ...items,
        nextItem
      ].slice(-transcriptHistoryLimit));
      return;
    }

    const id = activeAssistantId.current;
    setTranscript((items) =>
      items.map((item) =>
        item.id === id
          ? {...item, text: `${item.text ?? ''}${delta}`}
          : item
      )
    );
  };

  const callbacks: AgentCallbacks = {
    onAssistantMessage(message) {
      setShowThinking(false);
      activeAssistantId.current = null;
      addTranscript({
        kind: 'assistant',
        title: 'agent',
        text: message,
        tone: 'white'
      });
    },
    onAssistantMessageDelta(delta) {
      appendAssistantDelta(delta);
    },
    onToolStart(toolName, args) {
      activeAssistantId.current = null;
      addTranscript({
        kind: 'tool',
        title: toolName,
        text: summarizeToolStart(toolName, args),
        tone: 'blue',
        compact: true
      });
    },
    onToolResult(toolName, result: ToolResult) {
      addTranscript({
        kind: 'tool',
        title: `${result.success ? 'completed' : 'failed'} ${toolName}`,
        text: summarizeToolResult(result),
        tone: result.success ? 'green' : 'red',
        compact: true
      });
    },
    onTokenUsage(nextUsage) {
      setUsage((current) => ({
        promptTokens: current.promptTokens + nextUsage.promptTokens,
        completionTokens: current.completionTokens + nextUsage.completionTokens,
        totalTokens: current.totalTokens + nextUsage.totalTokens,
        requests: current.requests + 1
      }));
    },
    onError(error) {
      setShowThinking(false);
      addTranscript({
        kind: 'error',
        title: 'error',
        text: error.message,
        tone: 'red'
      });
    },
    requestApproval(request) {
      setShowThinking(false);
      activeAssistantId.current = null;
      addTranscript({
        kind: 'approval',
        title: `approval needed for ${request.toolName}`,
        text: compactPreview(request.preview),
        tone: 'yellow'
      });

      return new Promise<ApprovalDecision>((resolve) => {
        setApproval({request, resolve});
      });
    }
  };

  async function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || busy || approval) {
      return;
    }

    if (trimmed.startsWith('/')) {
      setInput('');
      handleSlashCommand(trimmed);
      return;
    }

    setInput('');
    setBusy(true);
    setScrollOffset(0);
    activeAssistantId.current = null;
    setThinkingStartedAt(Date.now());
    setThinkingSeconds(0);
    setShowThinking(true);
    if (transcript.length > 0) {
      addTranscript({
        kind: 'separator',
        title: 'turn separator',
        tone: 'gray',
        compact: true
      });
    }
    addTranscript({
      kind: 'user',
      title: 'you',
      text: trimmed,
      tone: 'cyan'
    });
    try {
      await agent.send(trimmed, callbacks);
    } finally {
      activeAssistantId.current = null;
      setBusy(false);
      setShowThinking(false);
    }
  }

  function resolveApproval(decision: ApprovalDecision) {
    if (!approval) {
      return;
    }

    const pendingApproval = approval;
    setApproval(null);
    addTranscript({
      kind: 'approval',
      title: decision.approved ? 'approved' : 'rejected',
      text: pendingApproval.request.toolName,
      tone: decision.approved ? 'green' : 'red',
      compact: true
    });
    setThinkingStartedAt(Date.now());
    setThinkingSeconds(0);
    setShowThinking(true);

    // Let Ink render the decision before the agent can request another approval.
    setImmediate(() => {
      pendingApproval.resolve(decision);
    });
  }

  function handleSlashCommand(command: string) {
    const [name] = command.slice(1).trim().split(/\s+/);
    const normalized = name?.toLowerCase() ?? '';

    if (normalized === 'clear') {
      setTranscript([]);
      setScrollOffset(0);
      activeAssistantId.current = null;
      return;
    }

    if (normalized === 'exit') {
      exit();
      return;
    }

    if (normalized === 'tokens') {
      addLocalCommand(command, formatUsage(usage));
      return;
    }

    if (normalized === 'model') {
      const model = command.slice('/model'.length).trim();
      if (model) {
        switchModel(command, model);
      } else {
        setNavigation('models');
      }
      return;
    }

    if (normalized === 'provider') {
      const provider = command.slice('/provider'.length).trim().toLowerCase();
      if (provider) {
        switchProvider(command, provider);
      } else {
        setNavigation('providers');
      }
      return;
    }

    if (normalized === 'cwd') {
      addLocalCommand(command, activeConfig.cwd);
      return;
    }

    if (normalized === 'help' || normalized === '') {
      setNavigation('commands');
      return;
    }

    addLocalCommand(command, `Unknown command: /${normalized}. Try /help.`);
  }

  function switchProvider(command: string, provider: string) {
    if (!isProviderName(provider)) {
      addLocalCommand(command, 'Unsupported provider. Available providers: cerebras, ollama.');
      return;
    }

    const model = defaultModelFor(provider);
    setActiveConfig((current) => ({
      ...current,
      provider,
      model,
      apiKey: provider === 'cerebras' ? process.env.CEREBRAS_API_KEY : undefined,
      baseUrl: provider === 'ollama' ? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434' : undefined
    }));
    setUsage(emptyUsage);
    activeAssistantId.current = null;
    addLocalCommand(command, `Provider switched to ${provider} (${model}).`);
  }

  function switchModel(command: string, model: string) {
    setActiveConfig((current) => ({...current, model}));
    setUsage(emptyUsage);
    activeAssistantId.current = null;
    addLocalCommand(command, `Model switched to ${model}.`);
  }

  function navigationOptions(screen: NavigationScreen): NavigationOption[] {
    if (screen === 'providers') {
      return availableProviders.map((provider) => ({
        value: provider,
        label: provider,
        description: defaultModelFor(provider),
        active: provider === activeConfig.provider
      }));
    }

    if (screen === 'models') {
      const models = [...new Set([activeConfig.model, ...availableModelsFor(activeConfig.provider)])];
      return models.map((model) => ({
        value: model,
        label: model,
        description: activeConfig.provider,
        active: model === activeConfig.model
      }));
    }

    return [
      {
        value: 'provider',
        label: '/provider',
        description: `${activeConfig.provider} (${activeConfig.model})`,
        hasChildren: true
      },
      {
        value: 'model',
        label: '/model',
        description: 'choose a model for the active provider',
        hasChildren: true
      },
      {value: 'tokens', label: '/tokens', description: formatUsage(usage)},
      {value: 'cwd', label: '/cwd', description: activeConfig.cwd},
      {value: 'clear', label: '/clear', description: 'clear the transcript'},
      {value: 'exit', label: '/exit', description: 'quit the agent'}
    ];
  }

  function selectNavigationOption(screen: NavigationScreen, value: string) {
    if (screen === 'providers') {
      setNavigation(null);
      switchProvider(`/provider ${value}`, value);
      return;
    }

    if (screen === 'models') {
      setNavigation(null);
      switchModel(`/model ${value}`, value);
      return;
    }

    if (value === 'provider' || value === 'model') {
      setNavigation(value === 'provider' ? 'providers' : 'models');
      return;
    }

    setNavigation(null);
    if (value === 'tokens') {
      addLocalCommand('/tokens', formatUsage(usage));
    } else if (value === 'cwd') {
      addLocalCommand('/cwd', activeConfig.cwd);
    } else if (value === 'clear') {
      setTranscript([]);
      setScrollOffset(0);
      activeAssistantId.current = null;
    } else if (value === 'exit') {
      exit();
    }
  }

  function navigateBack() {
    setNavigation((current) => {
      if (current === 'providers' || current === 'models') {
        return 'commands';
      }

      return null;
    });
  }

  function addLocalCommand(command: string, output: string) {
    setScrollOffset(0);
    if (transcript.length > 0) {
      addTranscript({
        kind: 'separator',
        title: 'turn separator',
        tone: 'gray',
        compact: true
      });
    }
    addTranscript({
      kind: 'user',
      title: 'you',
      text: command,
      tone: 'cyan'
    });
    addTranscript({
      kind: 'assistant',
      title: 'local',
      text: output,
      tone: 'white'
    });
  }

  return (
    <Box flexDirection="column" paddingX={2} height={viewportHeight} overflow="hidden">
      <Header config={activeConfig} busy={busy} usage={usage} />
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        paddingTop={1}
      >
        <Box justifyContent="space-between" marginBottom={1} flexShrink={0}>
          <Text color="white" bold>
            Conversation
          </Text>
          <Text color="gray" dimColor>
            {scrollOffset > 0
              ? `${scrollOffset} newer | Wheel/PageDown/End`
              : transcript.length > visibleTranscript.length
                ? 'Wheel/PageUp scroll | /help'
                : '/help'}
          </Text>
        </Box>
        {transcript.length === 0 && !showThinking ? (
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <EmptyState />
          </Box>
        ) : (
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {visibleTranscript.map((item) => (
              <TranscriptLine key={item.id} item={item} />
            ))}
            {showThinking && isAtTranscriptBottom ? (
              <ThinkingLine seconds={thinkingSeconds} />
            ) : null}
          </Box>
        )}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {approval ? (
          <ApprovalPanel approval={approval.request} onResolve={resolveApproval} />
        ) : navigation ? (
          <NavigationPanel
            key={navigation}
            screen={navigation}
            options={navigationOptions(navigation)}
            onSelect={(value) => {
              selectNavigationOption(navigation, value);
            }}
            onBack={navigateBack}
            onClose={() => {
              setNavigation(null);
            }}
          />
        ) : (
          <InputPanel input={input} busy={busy} onChange={setInput} onSubmit={submit} />
        )}
      </Box>
    </Box>
  );
}

function Header({
  config,
  busy,
  usage
}: {
  config: AgentConfig;
  busy: boolean;
  usage: UsageTotals;
}) {
  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="magentaBright" bold>
            TERMINAL
          </Text>
          <Text color="cyanBright" bold>
            {' '}
            AGENT
          </Text>
        </Box>
        <Text color={busy ? 'yellowBright' : 'greenBright'} bold>
          *{' '}
          <Text color="white">
            {busy ? 'WORKING' : 'READY'}
          </Text>
        </Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color="cyanBright">
          {config.provider}
          <Text color="gray"> / {config.model}</Text>
        </Text>
        <Text color="gray">{formatUsage(usage)}</Text>
      </Box>
      <Text color="gray" dimColor>
        {config.cwd}
      </Text>
    </Box>
  );
}

function EmptyState() {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text color="white">Ask me to inspect, edit, test, or explain this workspace.</Text>
      <Text color="gray" dimColor>
        Tool activity and approvals appear inline. Use /help for commands.
      </Text>
    </Box>
  );
}

function TranscriptLine({item}: {item: TranscriptItem}) {
  if (item.kind === 'separator') {
    return <TurnSeparator />;
  }

  if (item.compact) {
    return (
      <Box paddingLeft={messageIndent}>
        <Text color={item.tone} bold>
          {prefixFor(item.kind)} {compactTitle(item)}
        </Text>
        <Text color="gray" dimColor>
          {item.text ? `  ${truncateSingleLine(item.text, 100)}` : ''}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={item.tone} bold>
        {item.kind === 'user' ? '>' : item.kind === 'assistant' ? '<' : '!'}{' '}
        {labelFor(item)}
      </Text>
      <Box paddingLeft={messageIndent}>
        {item.text ? (
          <Text color={bodyColor(item)}>{truncateDisplayText(item.text, 1800)}</Text>
        ) : (
          <Text color="gray">No content</Text>
        )}
      </Box>
      {item.kind === 'assistant' ? (
        <Box paddingLeft={messageIndent}>
          <Text color="gray" dimColor>
            done
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function InputPanel({
  input,
  busy,
  onChange,
  onSubmit
}: {
  input: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor={busy ? 'yellowBright' : 'magentaBright'}
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <Text color="magentaBright" bold>
        {'> '}
      </Text>
      <Box flexGrow={1}>
        {busy ? (
          <Text color="gray">Agent is working...</Text>
        ) : (
          <PromptInput value={input} onChange={onChange} onSubmit={onSubmit} />
        )}
      </Box>
    </Box>
  );
}

function PromptInput({
  value,
  onChange,
  onSubmit
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((current) => Math.min(current, value.length));
  }, [value]);

  useInput((input, key) => {
    if (parseMouseWheel(input)) {
      return;
    }

    if (key.return) {
      onSubmit(value);
      setCursorOffset(0);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset((current) => Math.min(value.length, current + 1));
      return;
    }

    // Most Windows terminals send DEL (0x7F) for Backspace, which Ink exposes
    // as key.delete. Treat both flags as backward deletion for compatibility.
    if (key.backspace || key.delete) {
      if (cursorOffset === 0) {
        return;
      }

      const nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
      onChange(nextValue);
      setCursorOffset((current) => Math.max(0, current - 1));
      return;
    }

    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.tab || key.escape) {
      return;
    }

    if (!input || isMouseSequence(input)) {
      return;
    }

    const nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
    onChange(nextValue);
    setCursorOffset((current) => current + input.length);
  });

  return <Text>{formatPromptInput(value, cursorOffset)}</Text>;
}

function ThinkingLine({seconds}: {seconds: number}) {
  return (
    <Box paddingLeft={messageIndent}>
      <Text color="magentaBright" bold>
        * Thinking
      </Text>
      <Text color="gray"> {formatDuration(seconds)}</Text>
    </Box>
  );
}

function NavigationPanel({
  screen,
  options,
  onSelect,
  onBack,
  onClose
}: {
  screen: NavigationScreen;
  options: NavigationOption[];
  onSelect: (value: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((current) => (current - 1 + options.length) % options.length);
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => (current + 1) % options.length);
      return;
    }

    if (key.leftArrow) {
      onBack();
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    if (key.return || key.rightArrow) {
      const selected = options[selectedIndex];
      if (selected) {
        onSelect(selected.value);
      }
    }
  });

  return (
    <Box
      borderStyle="single"
      borderColor="cyanBright"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
      flexShrink={0}
    >
      <Box justifyContent="space-between">
        <Text color="cyanBright" bold>
          {navigationTitle(screen)}
        </Text>
        <Text color="gray">Up/Down move  Enter select  Left back  Esc close</Text>
      </Box>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <Box key={option.value}>
            <Box width={2}>
              <Text color={selected ? 'magentaBright' : 'gray'} bold={selected}>
                {selected ? '>' : ' '}
              </Text>
            </Box>
            <Box width={20} overflow="hidden">
              <Text
                color={selected ? 'white' : option.active ? 'greenBright' : 'gray'}
                bold={selected || option.active}
              >
                {option.label}
                {option.active ? '  active' : ''}
              </Text>
            </Box>
            <Text color={selected ? 'cyanBright' : 'gray'} dimColor={!selected}>
              {option.description}
              {option.hasChildren ? '  >' : ''}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function navigationTitle(screen: NavigationScreen): string {
  if (screen === 'providers') {
    return 'Select provider';
  }

  if (screen === 'models') {
    return 'Select model';
  }

  return 'Slash commands';
}

function TurnSeparator() {
  const {stdout} = useStdout();
  const width = Math.max(16, Math.min((stdout.columns ?? 88) - 8, 100));

  return (
    <Box>
      <Text color="gray" dimColor>
        {'-'.repeat(width)}
      </Text>
    </Box>
  );
}

function ApprovalPanel({
  approval,
  onResolve
}: {
  approval: ApprovalRequest;
  onResolve: (decision: ApprovalDecision) => void;
}) {
  const [selected, setSelected] = useState<'approve' | 'reject'>('approve');
  const [submitted, setSubmitted] = useState(false);

  function submitDecision(decision: 'approve' | 'reject') {
    if (submitted) {
      return;
    }

    setSubmitted(true);
    onResolve(
      decision === 'approve'
        ? {approved: true}
        : {approved: false, reason: 'User rejected the requested action.'}
    );
  }

  useInput((input, key) => {
    if (submitted || key.eventType === 'release') {
      return;
    }

    const normalized = input.trim().toLowerCase();
    if (normalized === 'y') {
      submitDecision('approve');
      return;
    }

    if (normalized === 'n' || key.escape) {
      submitDecision('reject');
      return;
    }

    if (key.leftArrow || key.upArrow) {
      setSelected('approve');
      return;
    }

    if (key.rightArrow || key.downArrow || key.tab) {
      setSelected('reject');
      return;
    }

    if (key.return) {
      submitDecision(selected);
    }
  });

  return (
    <Box
      borderStyle="single"
      borderColor="yellowBright"
      flexDirection="column"
      paddingX={1}
      marginTop={1}
      flexShrink={0}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text color="yellowBright" bold>
          Approval required
        </Text>
        <Text color="gray">
          {approval.toolName} / {approval.risk}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">args  {truncateSingleLine(formatArgs(approval.args), 120)}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Text>{truncateDisplayText(approval.preview, 500)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text
          color={selected === 'approve' ? 'black' : 'greenBright'}
          backgroundColor={selected === 'approve' ? 'greenBright' : undefined}
          bold
        >
          {' [Y] Approve '}
        </Text>
        <Text>  </Text>
        <Text
          color={selected === 'reject' ? 'white' : 'redBright'}
          backgroundColor={selected === 'reject' ? 'red' : undefined}
          bold
        >
          {' [N] Reject '}
        </Text>
        <Text color="gray">  Left/Right + Enter</Text>
      </Box>
    </Box>
  );
}

function summarizeToolStart(toolName: string, args: unknown): string {
  const label = pathOrCommand(args);
  return label ? label : formatArgs(args);
}

function summarizeToolResult(result: ToolResult): string {
  const details = result.diff
    ? summarizeDiff(result.diff)
    : result.content
      ? compactOutput(result.content)
      : undefined;

  return details ? `${result.summary}\n${details}` : result.summary;
}

function summarizeDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return `diff: +${added} -${removed}`;
}

function compactOutput(output: string): string {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return '';
  }

  return truncate(lines.slice(0, 6).join('\n'), 700);
}

function compactPreview(preview: string): string {
  if (preview.startsWith('Index:') || preview.includes('\n@@')) {
    return summarizeDiff(preview);
  }

  return truncate(preview, 700);
}

function pathOrCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') {
    return undefined;
  }

  const value = args as Record<string, unknown>;
  if (typeof value.path === 'string') {
    return value.path;
  }

  if (typeof value.command === 'string') {
    return value.command;
  }

  if (typeof value.query === 'string') {
    return `"${value.query}"`;
  }

  return undefined;
}

function formatArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args), 300);
  } catch {
    return String(args);
  }
}

function formatUsage(usage: UsageTotals): string {
  if (usage.requests === 0) {
    return '0 tokens';
  }

  return `${usage.totalTokens} tokens (${usage.promptTokens} in, ${usage.completionTokens} out)`;
}

function prefixFor(kind: TranscriptItem['kind']): string {
  if (kind === 'user') {
    return '>';
  }

  if (kind === 'assistant') {
    return '<';
  }

  if (kind === 'tool') {
    return '*';
  }

  if (kind === 'approval') {
    return '?';
  }

  if (kind === 'separator') {
    return '-';
  }

  return '!';
}

function labelFor(item: TranscriptItem): string {
  if (item.kind === 'user') {
    return 'YOU';
  }

  if (item.kind === 'assistant') {
    return 'AGENT';
  }

  if (item.kind === 'approval') {
    return 'APPROVAL';
  }

  if (item.kind === 'error') {
    return 'ERROR';
  }

  return item.title.toUpperCase();
}

function bodyColor(item: TranscriptItem): 'white' | 'yellow' | 'red' | 'gray' {
  if (item.kind === 'approval') {
    return 'yellow';
  }

  if (item.kind === 'error') {
    return 'red';
  }

  if (item.kind === 'tool') {
    return 'gray';
  }

  return 'white';
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function parseMouseWheel(input: string): 'up' | 'down' | undefined {
  const normalizedInput = stripEscapePrefix(input);
  const match = /^\[<(\d+);\d+;\d+[mM]$/.exec(normalizedInput);
  if (!match?.[1]) {
    return undefined;
  }

  const buttonCode = Number.parseInt(match[1], 10);
  if (!Number.isFinite(buttonCode) || (buttonCode & 64) === 0) {
    return undefined;
  }

  return (buttonCode & 1) === 0 ? 'up' : 'down';
}

function isMouseSequence(input: string): boolean {
  return /^\[<\d+;\d+;\d+[mM]$/.test(stripEscapePrefix(input));
}

function stripEscapePrefix(input: string): string {
  return input.codePointAt(0) === 0x1B ? input.slice(1) : input;
}

function formatPromptInput(value: string, cursorOffset: number): string {
  if (value.length === 0) {
    return ' ';
  }

  const beforeCursor = value.slice(0, cursorOffset);
  const cursorCharacter = value[cursorOffset] ?? ' ';
  const afterCursor = value.slice(cursorOffset + (value[cursorOffset] ? 1 : 0));
  return `${beforeCursor}\u001B[7m${cursorCharacter}\u001B[27m${afterCursor}`;
}

function selectVisibleTranscript(
  transcript: TranscriptItem[],
  maxRows: number,
  terminalWidth: number,
  endExclusive = transcript.length
): TranscriptItem[] {
  const selected: TranscriptItem[] = [];
  let usedRows = 0;

  for (let index = Math.min(endExclusive, transcript.length) - 1; index >= 0; index--) {
    const item = transcript[index];
    if (!item) {
      continue;
    }

    const itemRows = estimateTranscriptRows(item, terminalWidth);
    if (selected.length > 0 && usedRows + itemRows > maxRows) {
      break;
    }

    selected.unshift(item);
    usedRows += Math.min(itemRows, maxRows);

    if (usedRows >= maxRows) {
      break;
    }
  }

  return selected;
}

function estimateTranscriptRows(item: TranscriptItem, terminalWidth: number): number {
  if (item.kind === 'separator' || item.compact) {
    return 1;
  }

  const contentWidth = Math.max(24, terminalWidth - 10);
  const text = truncateDisplayText(item.text ?? '', 1800);
  const textRows = text
    .split(/\r?\n/)
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / contentWidth)), 0);
  const metadataRows = item.kind === 'assistant' ? 3 : 2;
  return Math.min(textRows, 8) + metadataRows;
}

function compactTitle(item: TranscriptItem): string {
  return truncateSingleLine(item.title.replace(/^completed /, 'done '), 32);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncateDisplayText(value: string, maxLength: number, maxLines = 8): string {
  const lengthLimited = value.length > maxLength
    ? `${value.slice(0, maxLength)}\n... truncated ...`
    : value;
  const lines = lengthLimited.split(/\r?\n/);

  if (lines.length <= maxLines) {
    return lengthLimited;
  }

  return `${lines.slice(0, maxLines).join('\n')}\n... ${lines.length - maxLines} more lines ...`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n... truncated ...`;
}

function isProviderName(value: string): value is ProviderName {
  return value === 'cerebras' || value === 'ollama';
}
