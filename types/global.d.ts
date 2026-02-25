declare global {
  type ApiResponse<T> = {
    ok: boolean;
    error?: string;
    data?: T;
  };

  interface DashboardFunds {
    houseTreasury: string;
    channelEscrow: string;
    totalManaged: string;
  }

  interface DashboardChannel {
    channel_id: string;
    agent_address: string;
    nonce: number;
    games_played?: number;
    agent_balance?: number;
    casino_balance?: number;
    invariantOk?: boolean;
  }

  interface DashboardState {
    server?: {
      now?: string;
      chainId?: number;
      degraded?: boolean;
      warning?: string;
    };
    funds: DashboardFunds;
    channels?: DashboardChannel[];
    stats?: Record<string, unknown>;
    contracts?: Record<string, string>;
    games?: Record<string, unknown>;
  }

  interface ArenaLastGame {
    game: string;
    bet: string;
    payout: string;
    won: boolean;
    timestamp: number;
    result?: string;
    choice?: string;
    multiplier?: number;
  }

  interface ArenaAgent {
    agent: string;
    agentBalance: string;
    casinoBalance: string;
    nonce: number;
    gamesPlayed: number;
    openedAt: number;
    lastGame: ArenaLastGame | null;
  }

  interface AgentRecentGame {
    game: string;
    bet: string;
    payout: string;
    won: boolean;
    timestamp: number;
    nonce: number;
  }

  interface AgentProfile {
    agent: string;
    status: string;
    channel: {
      agentDeposit: string;
      casinoDeposit: string;
      agentBalance: string;
      casinoBalance: string;
      nonce: number;
      openedAt: number;
    };
    performance: {
      netPnl: string;
      netPnlPercent: string;
      totalRounds: number;
      agentWins: number;
      houseWins: number;
      winRate: string;
      totalWagered: string;
      totalPayout: string;
      currentStreakType: string;
      currentStreak: number;
    };
    recentGames: AgentRecentGame[];
  }
}

export {};
