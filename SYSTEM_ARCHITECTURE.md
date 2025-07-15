# XMTP Flaunchy Chatbot - System Architecture Documentation

This document provides comprehensive diagrams for all components of the XMTP Flaunchy chatbot system. Each diagram illustrates different aspects of the system architecture to help with debugging, development, and onboarding.

## Table of Contents

1. [Application Initialization & Main Flow](#1-application-initialization--main-flow)
2. [XMTP Status Monitor & Restart Manager](#2-xmtp-status-monitor--restart-manager)
3. [Enhanced Message Coordinator - Message Processing](#3-enhanced-message-coordinator---message-processing)
4. [Enhanced Message Coordinator - Message Filtering](#4-enhanced-message-coordinator---message-filtering)
5. [Flow Router & Intent Classification](#5-flow-router--intent-classification)
6. [User State Management & Storage](#6-user-state-management--storage)
7. [Flow Processing System](#7-flow-processing-system)
8. [Direct Message Handling System](#8-direct-message-handling-system)
9. [Services Architecture & Integration](#9-services-architecture--integration)
10. [Installation Manager & XMTP Client](#10-installation-manager--xmtp-client)
11. [Coin Launch Flow - Detailed Process](#11-coin-launch-flow---detailed-process)
12. [Attachment-Only Message Handling](#12-attachment-only-message-handling)
13. [Complete System Architecture Overview](#13-complete-system-architecture-overview)

---

## 1. Application Initialization & Main Flow

This diagram shows the complete startup process from environment loading to the message processing loop, including XMTP client creation and component initialization with monitoring.

```mermaid
graph TD
    A[Start Application] --> B[main Function]
    B --> C[Create XMTPStatusMonitor]
    C --> D[startWithMonitoring with createApplication factory]
    D --> E[Execute createApplication Function]

    E --> F[Validate Environment Variables]
    F --> G[Create OpenAI Client]
    G --> H[Create Signer & Encryption Key]
    H --> I[Ensure Storage Directory Exists]
    I --> J[Try Reuse Existing XMTP Installation]

    J --> K{buildExistingClient Success?}
    K -->|Yes| L[Use Existing Client]
    K -->|No| M[InstallationManager.createClient]

    M --> N{Hit Installation Limit?}
    N -->|Yes| O[onInstallationLimitExceeded Callback]
    N -->|No| P[Client Created Successfully]
    O --> Q{Retry Allowed?}
    Q -->|Yes| M
    Q -->|No| R[Exit with Error]

    L --> S[Initialize Core Components]
    P --> S

    S --> T[FileStateStorage - user-states.json]
    S --> U[SessionManager with StateStorage]
    S --> V[Flow Registry - QA, Management, CoinLaunch]
    S --> W[FlowRouter with OpenAI]
    S --> X[EnhancedMessageCoordinator with 1s coordination]
    S --> Y[XMTPStatusMonitor for volume path]

    T --> Z[Sync Conversations]
    U --> Z
    V --> Z
    W --> Z
    X --> Z

    Z --> AA[Start Message Stream]
    AA --> BB[Create Background Message Processing Promise]
    BB --> CC[For Each Message in Stream]
    CC --> DD[Process via messageCoordinator.processMessage]
    DD --> EE[Handle Errors with Fallback Response]
    EE --> CC

    FF[Return Application Resources] --> GG[client, statusMonitor, messageStream, cleanup]
    GG --> HH[Status Monitor Starts Monitoring]
    HH --> II[Application Running with Auto-Restart]

    Y --> FF
    AA --> FF

    style A fill:#1565C0,color:#ffffff
    style S fill:#7B1FA2,color:#ffffff
    style Z fill:#2E7D32,color:#ffffff
    style BB fill:#F57C00,color:#ffffff
    style II fill:#4CAF50,color:#ffffff
```

---

## 2. XMTP Status Monitor & Restart Manager

This diagram details the monitoring system that watches the XMTP status page and automatically restarts the application when issues are detected or resolved.

```mermaid
graph TD
    A[XMTPStatusMonitor.startWithMonitoring] --> B[Store Application Factory]
    B --> C[runApplication - First Time]
    C --> D[Create Application Resources]
    D --> E[Update Startup Time in JSON]
    E --> F[startMonitoring]

    F --> G[Set Check Interval - 5 minutes]
    G --> H[performCheck - Initial]
    H --> I[checkForNewIssues]

    I --> J[Fetch RSS Feed - status.xmtp.org]
    J --> K[Parse Incidents]
    K --> L{Filter Critical Incidents}

    L --> M[Check: Not Resolved AND After Startup]
    L --> N[Check: Node SDK Issues AND Recent 24h]

    M --> O{Critical Issues Found?}
    N --> O
    O -->|Yes| P[Trigger Restart]
    O -->|No| Q[Check Resolved Issues]

    Q --> R{New Resolved Issues?}
    R -->|Yes| P
    R -->|No| S[Continue Monitoring]

    P --> T[stopMonitoring]
    T --> U[handleRestart]
    U --> V[Set isRestarting = true]
    V --> W[cleanup - Current Resources]
    W --> X[Wait 2 seconds]
    X --> Y[runApplication - Restart Mode]
    Y --> Z[Create New Resources]
    Z --> AA[Update Startup Time]
    AA --> BB[Restart Monitoring]
    BB --> CC[Set isRestarting = false]

    S --> DD[Wait 5 minutes]
    DD --> H

    CC --> H

    style A fill:#1565C0,color:#ffffff
    style P fill:#D32F2F,color:#ffffff
    style U fill:#F57C00,color:#ffffff
    style J fill:#7B1FA2,color:#ffffff
```

---

## 3. Enhanced Message Coordinator - Message Processing

This diagram illustrates how messages are received, coordinated (text + attachments), and queued for processing with proper timing, including direct message handling and improved transaction reference processing.

```mermaid
graph TD
    A[Incoming Message] --> B[EnhancedMessageCoordinator.processMessage]
    B --> C{Skip Bot Messages?}
    C -->|Yes| D[Return false]
    C -->|No| E{Skip Read Receipts?}
    E -->|Yes| D
    E -->|No| F{Skip Wallet Send Calls?}
    F -->|Yes| D
    F -->|No| G{Transaction Reference?}
    G -->|Yes| H[handleTransactionReference with Null Checks]
    G -->|No| I{Skip Transaction Receipts '...'?}
    I -->|Yes| D
    I -->|No| J[Determine Message Type & Queue]

    H --> H1[Validate Message Content & Reference]
    H1 --> H2{Valid TX Hash?}
    H2 -->|No| H3[Log Error & Return false]
    H2 -->|Yes| H4[Get User & Group State]
    H4 --> H5{Pending Transaction?}
    H5 -->|No| H3
    H5 -->|Yes| H6[Process Transaction Receipt]
    H6 --> H7[Extract Contract Address from Receipt]
    H7 --> H8[Update User Status to Active]
    H8 --> H9[Ensure Group Exists for Chat Room]
    H9 --> H10[Store Coin for All Members]
    H10 --> H11[Clear Progress & Pending TX]

    J --> K{Is Attachment?}
    K -->|Yes| L[Add to Attachment Queue]
    K -->|No| M[Add to Text Queue]

    L --> N{Text Message Waiting?}
    N -->|Yes| O[Process Both Together]
    N -->|No| P[Set Timer - 1 second]

    M --> Q{Attachment Waiting?}
    Q -->|Yes| O
    Q -->|No| R[Set Timer - 1 second]

    P --> S[Timer Expires]
    S --> T[Process Attachment Alone]
    R --> S
    S --> U[Process Text Alone]

    O --> V[processCoordinatedMessages]
    T --> V
    U --> V

    V --> W[Get Primary Message & Related Messages]
    W --> X[Get Conversation & Check Member Count]
    X --> Y{Is Direct Message?}
    Y -->|Yes| Z[Detect Intent with FlowRouter]
    Y -->|No| AA[Get User State by Address]

    Z --> BB{Management/Coin Launch Intent?}
    BB -->|Yes| CC[Send Group Requirement Message]
    BB -->|No| DD[Continue to QA Flow Processing]

    CC --> EE[Return true - DM Handled]
    DD --> AA

    AA --> FF[Get Group State & Check Reply Context]
    FF --> GG[shouldProcessMessage with Advanced Filtering]
    GG --> HH{Should Process?}
    HH -->|No| II[Return false]
    HH -->|Yes| JJ[Send Paw Reaction 🐾]

    JJ --> KK[createFlowContext with All Context]
    KK --> LL[Extract Combined Message Text & Attachments]
    LL --> MM[Create Helper Functions & Services]
    MM --> NN[flowRouter.routeMessage with Multi-Intent]

    style A fill:#1565C0,color:#ffffff
    style V fill:#7B1FA2,color:#ffffff
    style Y fill:#F57C00,color:#ffffff
    style CC fill:#D32F2F,color:#ffffff
    style H fill:#8E24AA,color:#ffffff
    style H6 fill:#2E7D32,color:#ffffff
    style H8 fill:#388E3C,color:#ffffff
    style H9 fill:#388E3C,color:#ffffff
    style H10 fill:#388E3C,color:#ffffff
    style GG fill:#4CAF50,color:#ffffff
    style NN fill:#2E7D32,color:#ffffff
```

---

## 4. Enhanced Message Coordinator - Message Filtering

This diagram shows the sophisticated filtering system that determines whether to process messages in group chats based on mentions, replies, active threads, and special coin launch contexts.

```mermaid
graph TD
    A[shouldProcessMessage] --> B{Is Group Chat?}
    B -->|No| C[Always Process - 1:1 Chat]
    B -->|Yes| D[Extract Combined Message Text from Primary + Related]

    D --> E{Coin Launch Progress + Image Only?}
    E -->|Yes| F[Update Active Thread - Processing]
    F --> G[Return true - Coin Data Collection]

    E -->|No| H{Reply to Image During Coin Launch?}
    H -->|Yes| I[Update Active Thread - Processing]
    I --> J[Return true - Coin Launch Context]

    H -->|No| K[isReplyToAgentMessage]
    K --> L{Reply to Agent?}
    L -->|Yes| M{Non-Text Reply?}
    M -->|Yes| N[Update Active Thread - Don't Process]
    M -->|No| O[Update Active Thread - Process]

    N --> P[Return false - Non-Text Reply]
    O --> Q[Return true - High Confidence]

    L -->|No| R{Is Reply to Other User?}
    R -->|Yes| S[detectExplicitAgentMention]
    S --> T{Has @mention?}
    T -->|No| U[Return false - Ignore Reply]
    T -->|Yes| V[Process with Explicit Mention]

    R -->|No| W[detectObviousAgentMention]
    W --> X{Obvious Mention?}
    X -->|Yes| Y[Update Active Thread]
    Y --> Z[Return true - Obvious Mention]

    X -->|No| AA[Return false - No Engagement]

    style A fill:#1565C0,color:#ffffff
    style E fill:#8E24AA,color:#ffffff
    style F fill:#4CAF50,color:#ffffff
    style G fill:#4CAF50,color:#ffffff
    style L fill:#D32F2F,color:#ffffff
    style O fill:#D32F2F,color:#ffffff
    style Q fill:#4CAF50,color:#ffffff
    style T fill:#F57C00,color:#ffffff
    style V fill:#2E7D32,color:#ffffff
    style Y fill:#2E7D32,color:#ffffff
    style Z fill:#4CAF50,color:#ffffff
    style AA fill:#607D8B,color:#ffffff

    classDef removed fill:#ffcccc,stroke:#ff6666,stroke-width:2px,color:#000000

    BB[REMOVED: LLM Engagement Check]:::removed
    CC[REMOVED: Active Thread Continuation]:::removed
    DD[REMOVED: Complex Thread Management]:::removed
    EE["Note: LLM engagement detection and active thread<br/>continuation logic has been simplified to reduce<br/>costs and improve reliability"]:::removed
```

---

## 5. Flow Router & Intent Classification

This diagram documents the updated LLM-based intent classification system that routes messages to appropriate flows based on user intent and context, with sophisticated multi-intent detection and priority-based routing.

```mermaid
graph TD
    A[FlowRouter.routeMessage] --> B{Skip '...' Messages?}
    B -->|Yes| C[Return - Transaction Receipt]
    B -->|No| D[detectMultipleIntents with GPT-4o-mini]

    D --> E[Build Comprehensive Context Prompt]
    E --> F[User Status, Groups, Coins, Pending TX, Message Analysis]
    F --> G[Critical Coin Launch Pattern Detection]
    G --> H[Context-Aware Intent Classification]

    H --> I[Parse Primary Intent with Confidence]
    I --> J[Parse Secondary Intents Array]
    J --> K[Parse Flags - Greeting, Transaction, Status, Cancellation]

    K --> L[Validate & Sanitize Multi-Intent Result]
    L --> M[getPrimaryFlow with Priority System]

    M --> N{PRIORITY 0: Existing Coin Launch Progress?}
    N -->|Yes| O[coin_launch - Continue Progress]
    N -->|No| P{PRIORITY 1: High Confidence Status Inquiry?}

    P -->|Yes| Q[qa - Status Inquiry with Live Data]
    P -->|No| R{PRIORITY 2: Action Type Classification?}

    R -->|coin_launch| S[coin_launch - New Launch with Auto Group]
    R -->|modify_existing| T{Modify Existing What?}
    R -->|other| U[Continue to Lower Priority]

    T -->|coin_creation| V[coin_launch - Modify Coin Parameters]
    T -->|group_creation| W[management - Modify Group]
    T -->|none| X[management - General Management]

    U --> Y{PRIORITY 3: Question Type?}
    Y -->|inquiry| Z[qa - General Questions & Help]
    Y -->|other| AA{PRIORITY 4: Management Tasks?}

    AA -->|management/cancel| BB[management - Task Management]
    AA -->|other| CC{PRIORITY 5: Social Interaction?}

    CC -->|social/greeting| DD[qa - Explain Agent Capabilities]
    CC -->|other| EE[qa - Help & Fallback]

    O --> FF[Add Multi-Intent Result to Context]
    Q --> FF
    S --> FF
    V --> FF
    W --> FF
    X --> FF
    Z --> FF
    BB --> FF
    DD --> FF
    EE --> FF

    FF --> GG[Execute Flow.processMessage with Full Context]

    HH[Enhanced Features] --> II[Coin Launch Pattern Recognition]
    HH --> JJ[Secondary Intent Handling]
    HH --> KK[Context-Aware Routing]
    HH --> LL[Confidence-Based Priority]

    style A fill:#1565C0,color:#ffffff
    style D fill:#7B1FA2,color:#ffffff
    style E fill:#8E24AA,color:#ffffff
    style M fill:#F57C00,color:#ffffff
    style N fill:#D32F2F,color:#ffffff
    style O fill:#4CAF50,color:#ffffff
    style GG fill:#2E7D32,color:#ffffff
    style HH fill:#FF9800,color:#ffffff
```

---

## 6. User State Management & Storage

This diagram explains how user data is stored in `user-states.json`, including state creation, updates, multi-user group management, group-specific states, and advanced live data injection.

```mermaid
graph TD
    A[User Message] --> B[Get Creator Address from InboxId]
    B --> C[SessionManager.getUserState]

    C --> D[FileStateStorage.get]
    D --> E{User State Exists?}
    E -->|No| F[createNewUserState]
    E -->|Yes| G[Load from user-states.json with Date Parsing]

    F --> H[Initialize New User]
    H --> I[Status: 'new']
    I --> J[Empty Groups & Coins Arrays]
    J --> K[Empty GroupStates Object]
    K --> L[Default Preferences]
    L --> M[Save to Storage]

    G --> N[Parse JSON & Convert Date Objects]
    N --> O[Return User State with GroupStates]

    M --> P[User State Available]
    O --> P

    P --> Q[Flow Processing Requires Group State]
    Q --> R[SessionManager.getGroupState]
    R --> S[Extract Group-Specific State]
    S --> T[Return GroupState for Conversation]

    U[Flow Updates Group State] --> V[SessionManager.updateGroupState]
    V --> W[Merge Updates with Group-Specific State]
    W --> X[Update User.groupStates[groupId]]
    X --> Y[Set updatedAt = now]
    Y --> Z[FileStateStorage.set]

    Z --> AA[Convert to JSON with Date Serialization]
    AA --> BB[Write to user-states.json]

    CC[GroupStorageService] --> DD[storeGroupForAllReceivers]
    DD --> EE[Collect All Ethereum Addresses]
    EE --> FF[Iterate All Receiver Addresses]
    FF --> GG[Get/Create User State for Each Address]
    GG --> HH[Check if User Exists]
    HH --> II{User Existed Before?}
    II -->|No| JJ[Mark as 'invited']
    II -->|Yes| KK[Keep Current Status]
    JJ --> LL[Add Group to User]
    KK --> LL

    MM[UserDataService] --> NN[injectGroupData]
    NN --> OO[Fetch from GraphQL API]
    OO --> PP[Update Groups with Live Data]
    PP --> QQ[Update Coins with Live Data]
    QQ --> RR[Discover New Coins from API]
    RR --> SS[Return Enriched State]

    TT[SessionManager.getUserStateWithLiveData] --> UU{User has Groups or Coins?}
    UU -->|Yes| VV[Inject Live Data for All Users]
    UU -->|No| WW[Return State Without Live Data]

    VV --> XX[Call UserDataService.injectGroupData]
    XX --> YY[Save Enriched State to Storage]
    YY --> ZZ[Return Enriched State]

    AAA[Coin Launch Success] --> BBB[Update User Status]
    BBB --> CCC{User Status 'new' or 'onboarding'?}
    CCC -->|Yes| DDD[Update to 'active']
    CCC -->|No| EEE[Keep Current Status]

    DDD --> FFF[Clear Progress & Pending TX]
    FFF --> GGG[User Now Active]

    style A fill:#1565C0,color:#ffffff
    style F fill:#7B1FA2,color:#ffffff
    style K fill:#8E24AA,color:#ffffff
    style Z fill:#F57C00,color:#ffffff
    style MM fill:#2E7D32,color:#ffffff
    style TT fill:#388E3C,color:#ffffff
    style UU fill:#388E3C,color:#ffffff
    style VV fill:#4CAF50,color:#ffffff
    style AAA fill:#8E24AA,color:#ffffff
    style BBB fill:#AD1457,color:#ffffff
    style DDD fill:#388E3C,color:#ffffff
```

---

## 7. Flow Processing System

This diagram shows how the three main flows (QA, Management, Coin Launch) process different types of user messages and handle various scenarios, with sophisticated direct message handling and advanced state management.

```mermaid
graph TD
    A[FlowRouter Routes to Flow] --> B{Which Flow?}

    B -->|QA Flow| C[QAFlow.processMessage]
    B -->|Management Flow| D[ManagementFlow.processMessage]
    B -->|Coin Launch Flow| E[CoinLaunchFlow.processMessage]

    C --> F{Is Direct Message?}
    F -->|Yes| G[Detect Groups/Coins Query]
    G --> H{Groups/Coins Query?}
    H -->|Yes| I[Fetch Live Data & Display]
    H -->|No| J[Send Structured Group Requirement Message]
    F -->|No| K[Check Multiple Coin Request]

    K --> L{Multiple Coins?}
    L -->|Yes| M[Handle Multiple Coin Request]
    L -->|No| N[Check Existing Groups]

    N --> O{User Has Groups?}
    O -->|Yes| P[Extract Coin Launch Details]
    P --> Q{Coin Launch Detected?}
    Q -->|Yes| R{Existing Coin Launch Progress?}
    Q -->|No| S[Classify Question Type]

    R -->|Yes| T[GUARD: Don't Override - Send Warning]
    R -->|No| U[Initialize Coin Launch Progress]

    S --> V{Question Type?}
    V -->|Capability| W[Handle Capability Question with Context]
    V -->|Status| X[Handle Status Inquiry with Live Data]
    V -->|General| Y[Handle General Question]

    D --> Z{User Status?}
    Z -->|invited| AA[Handle Invited User Welcome]
    Z -->|other| BB[Clear Cross-Flow Transactions]

    BB --> CC{Pending Transaction?}
    CC -->|Yes| DD[Classify Transaction Intent]
    DD --> EE{Intent Type?}
    EE -->|cancel| FF[Cancel Transaction]
    EE -->|modify| GG[Modify Transaction Parameters]
    EE -->|inquiry| HH[Handle Transaction Inquiry]

    CC -->|No| II{Management Progress?}
    II -->|Yes| JJ[Handle Ongoing Process]
    II -->|No| KK[Classify Management Action]

    KK --> LL{Action Type?}
    LL -->|list_groups| MM[List Groups with Live Data]
    LL -->|list_coins| NN[List Coins with Live Data]
    LL -->|claim_fees| OO[Claim Fees]
    LL -->|check_fees| PP[Check Fees]
    LL -->|cancel_transaction| QQ[Cancel Transaction]
    LL -->|general_help| RR[General Help]

    E --> SS[Clear Cross-Flow Transactions]
    SS --> TT{Pending Transaction?}
    TT -->|Yes| UU[Handle Pending Transaction Update]
    TT -->|No| VV[Handle Inquiry Types]

    VV --> WW{Inquiry Type?}
    WW -->|launch_options| XX[Handle Launch Options]
    WW -->|future_features| YY[Handle Future Features]
    WW -->|launch_defaults| ZZ[Handle Launch Defaults]
    WW -->|status| AAA[Handle Status Inquiry]
    WW -->|launch_command| BBB[Handle Launch Command]
    WW -->|other| CCC[Process Coin Launch Request]

    CCC --> DDD{Coin Launch Progress?}
    DDD -->|Yes| EEE[Continue From Progress]
    DDD -->|No| FFF[Start New Coin Launch]

    EEE --> GGG{Attachment-Only During Data Collection?}
    GGG -->|Yes| HHH[Handle Attachment-Only Special Case]
    GGG -->|No| III[Normal Progress Continuation]

    FFF --> JJJ[Extract Coin Data with LLM]
    JJJ --> KKK{Has All Required Data?}
    KKK -->|Yes| LLL[Launch Coin with Auto Group Creation]
    KKK -->|No| MMM[Request Missing Data]

    style A fill:#1565C0,color:#ffffff
    style C fill:#7B1FA2,color:#ffffff
    style D fill:#F57C00,color:#ffffff
    style E fill:#2E7D32,color:#ffffff
    style I fill:#4CAF50,color:#ffffff
    style J fill:#D32F2F,color:#ffffff
    style R fill:#8E24AA,color:#ffffff
    style T fill:#D32F2F,color:#ffffff
    style U fill:#4CAF50,color:#ffffff
    style GGG fill:#AD1457,color:#ffffff
    style HHH fill:#4CAF50,color:#ffffff
    style LLL fill:#388E3C,color:#ffffff
```

---

## 8. Direct Message Handling System

This diagram shows how the system handles direct messages (1-on-1 conversations) differently from group chats, with sophisticated intent detection, live data fetching for groups/coins queries, and structured guidance for blocked functionality.

```mermaid
graph TD
    A[Direct Message Received] --> B[EnhancedMessageCoordinator]
    B --> C[Check Member Count - Detect 1-on-1]
    C --> D[Detect Intent with FlowRouter Multi-Intent]
    D --> E[Classify Message Intent with Context]

    E --> F{Intent Type Routing?}
    F -->|Management| G[Block with Group Requirement]
    F -->|Coin Launch| H[Block with Group Requirement]
    F -->|QA/General| I[Allow QA Flow Processing]

    G --> J[Send Structured Group Requirement Message]
    H --> J
    I --> K[QAFlow.processMessage with DM Flag]

    J --> L[Structured Response:<br/>1. Create group chat with friends<br/>2. Add bot to group<br/>3. Launch coins with automatic fee splitting<br/>4. Magic happens when everyone's together]

    K --> M{Question Type Detection?}
    M -->|Status| N[Detect Status Inquiry Type]
    M -->|Capability| O[Handle Capability Question]
    M -->|General| P[Handle General Question]

    N --> Q{Groups/Coins Query Detection?}
    Q -->|Yes| R[Fetch Live Data from Blockchain]
    Q -->|No| S[Send Structured Group Requirement]

    R --> T[SessionManager.getUserStateWithLiveData]
    T --> U[UserDataService.injectGroupData]
    U --> V[GraphQLService.fetchGroupData]
    V --> W[Display Actual Groups/Coins with Live Data]

    W --> X[Format Groups with Recipients & Fees]
    X --> Y[Show Holders, Market Cap, Total Fees]
    Y --> Z[Display Contract Addresses & Live Data]

    O --> AA[Handle Capability Questions with Context]
    P --> BB[Handle General Questions with Context]
    S --> CC[Same Structured Response:<br/>Bot works in groups only]

    AA --> CC
    BB --> CC

    DD[Group Chat] --> EE[Normal Flow Processing]
    EE --> FF[Full Functionality Available]
    FF --> GG[User State Updates & Group States]
    FF --> HH[Coin Launch with Auto Group Creation]
    FF --> II[Management Features & Live Data]

    JJ[Enhanced DM Features] --> KK[Live Data Fetching for Status]
    JJ --> LL[Sophisticated Intent Detection]
    JJ --> MM[Context-Aware Responses]
    JJ --> NN[Flow-Based Routing]

    style A fill:#1565C0,color:#ffffff
    style G fill:#D32F2F,color:#ffffff
    style H fill:#D32F2F,color:#ffffff
    style L fill:#F57C00,color:#ffffff
    style R fill:#2E7D32,color:#ffffff
    style T fill:#388E3C,color:#ffffff
    style U fill:#388E3C,color:#ffffff
    style V fill:#388E3C,color:#ffffff
    style W fill:#4CAF50,color:#ffffff
    style X fill:#4CAF50,color:#ffffff
    style Y fill:#4CAF50,color:#ffffff
    style Z fill:#4CAF50,color:#ffffff
    style DD fill:#2E7D32,color:#ffffff
    style JJ fill:#FF9800,color:#ffffff
```

---

## 9. Services Architecture & Integration

This diagram illustrates how all the services (GraphQL, UserData, ENS, GroupStorage, StatusMonitor) work together to provide functionality with sophisticated integration patterns.

```mermaid
graph TD
    A[Service Layer] --> B[GraphQLService]
    A --> C[UserDataService]
    A --> D[ENSResolverService]
    A --> E[GroupStorageService]
    A --> F[XMTPStatusMonitor]

    B --> G[Fetch Group Data from API]
    G --> H[Query addressFeeSplitManagers by Group Addresses]
    H --> I[Get Live Token Data with Market Cap]
    I --> J[Get Fee Information & Pool Data]
    J --> K[Return Structured GroupData with Holdings]

    C --> L[injectGroupData - Comprehensive Live Data]
    L --> M[Use GraphQLService for API Data]
    M --> N[Enrich Groups with Live Data & Recipients]
    N --> O[Enrich Coins with Live Data & Market Info]
    O --> P[Discover New Coins from Blockchain]
    P --> Q[Return Fully Enriched State]

    D --> R[Batch Address Resolution]
    R --> S[Query API for ENS/Basename Data]
    S --> T[Process Display Names & Avatars]
    T --> U[Return Display Name Map]
    U --> V[Fallback to Shortened Addresses]

    E --> W[storeGroupForAllReceivers]
    W --> X[Collect All Ethereum Addresses]
    X --> Y[Get/Create User States for Each]
    Y --> Z[Add Group to Each User]
    Z --> AA[Mark New Users as 'invited']
    AA --> BB[Generate Fun Group Names]

    F --> CC[Monitor XMTP Status with RSS]
    CC --> DD[Fetch & Parse RSS Feed]
    DD --> EE[Filter Critical Incidents]
    EE --> FF[Check Node SDK & Production Issues]
    FF --> GG{Issues Found or Resolved?}
    GG -->|Yes| HH[Trigger Application Restart]
    GG -->|No| II[Continue Monitoring - 5 min intervals]

    HH --> JJ[Graceful Cleanup & Restart]
    JJ --> KK[Recreate Application Resources]
    KK --> LL[Resume Normal Operation]

    MM[Flow Context Integration] --> B
    MM --> C
    MM --> D
    MM --> E

    NN[Enhanced Features] --> OO[Chain-Specific Data Support]
    NN --> PP[Live Data Caching & Persistence]
    NN --> QQ[Automatic Status Updates]
    NN --> RR[Multi-User Group Management]

    style A fill:#1565C0,color:#ffffff
    style MM fill:#7B1FA2,color:#ffffff
    style B fill:#F57C00,color:#ffffff
    style C fill:#2E7D32,color:#ffffff
    style D fill:#4CAF50,color:#ffffff
    style E fill:#8E24AA,color:#ffffff
    style F fill:#FFA726,color:#ffffff
    style NN fill:#FF9800,color:#ffffff
    style HH fill:#D32F2F,color:#ffffff
    style Q fill:#4CAF50,color:#ffffff
```

---

## 10. Installation Manager & XMTP Client

This diagram documents the XMTP client creation process, including installation limit handling and retry logic.

```mermaid
graph TD
    A[Application Startup] --> B[Try Existing Installation]
    B --> C[InstallationManager.buildExistingClient]

    C --> D[Create Codecs Array]
    D --> E[WalletSendCallsCodec, RemoteAttachmentCodec, etc.]
    E --> F[Client.create with Existing DB]

    F --> G{Client Creation Success?}
    G -->|Yes| H[Return Existing Client]
    G -->|No| I[Log Build Error]

    I --> J[Fallback to New Installation]
    J --> K[InstallationManager.createClient]

    K --> L[Setup Retry Loop - 3 attempts]
    L --> M[Client.create with New DB]

    M --> N{Client Creation Success?}
    N -->|Yes| O[Return New Client]
    N -->|No| P[Parse Error Type]

    P --> Q{Installation Limit Error?}
    Q -->|Yes| R[Call onInstallationLimitExceeded]
    Q -->|No| S[Exponential Backoff Wait]

    R --> T{Callback Says Retry?}
    T -->|Yes| U[Continue Retry Loop]
    T -->|No| V[Throw Installation Limit Error]

    S --> W{More Attempts?}
    W -->|Yes| U
    W -->|No| X[Throw Final Error]

    U --> M

    Y[Error Handling] --> Z[Suggest Cleanup Actions]
    Z --> AA[Notify Administrators]
    AA --> BB[Try Fallback Strategy]

    style A fill:#1565C0,color:#ffffff
    style C fill:#7B1FA2,color:#ffffff
    style K fill:#F57C00,color:#ffffff
    style V fill:#D32F2F,color:#ffffff
    style O fill:#2E7D32,color:#ffffff
```

---

## 11. Coin Launch Flow - Detailed Process

This diagram provides a detailed breakdown of the coin launch process, from message extraction to transaction creation, with automatic group creation and proper coin storage for all members.

```mermaid
graph TD
    A[CoinLaunchFlow.processMessage] --> B[Clear Cross-Flow Transactions]
    B --> C{Pending Transaction?}
    C -->|Yes| D[Handle Pending Transaction Update]
    C -->|No| E[Check Inquiry Types]

    E --> F{Launch Options Inquiry?}
    F -->|Yes| G[Handle Launch Options]
    F -->|No| H{Status Inquiry?}
    H -->|Yes| I[Handle Status Inquiry]
    H -->|No| J{Launch Command?}
    J -->|Yes| K[Handle Launch Command]
    J -->|No| L{Coin Launch Progress?}

    L -->|Yes| M[Continue From Progress]
    L -->|No| N[Start New Coin Launch]

    M --> O{SPECIAL CASE: Attachment-Only?}
    O -->|Yes| P[Handle Attachment During Data Collection]
    O -->|No| Q[Extract Coin Data from Message]

    P --> R[Update Image Data: "attachment_provided"]
    R --> S[Send Acknowledgment: "got the image! 📸"]
    S --> T[Check If All Data Complete]
    T --> U{Has Name, Ticker, Image?}
    U -->|Yes| V[Get Manager Info & Launch]
    U -->|No| W[Request Missing Data]

    Q --> X[LLM Extraction using GPT-4o-mini]
    X --> Y[Parse Token Details]
    Y --> Z[Parse Launch Parameters]
    Z --> AA[Validate Extracted Data]

    AA --> BB{Has Name, Ticker, Image?}
    BB -->|Yes| CC[Get Chat Room Manager Address]
    BB -->|No| DD[Request Missing Data]

    CC --> EE{First Launch in Chat?}
    EE -->|Yes| FF[Create Initialize Data]
    EE -->|No| GG[Use Existing Manager]

    FF --> HH[Get All Chat Members]
    HH --> II[Create Fee Split Data]
    II --> JJ[Encode ABI Parameters]

    GG --> KK[Launch Coin]
    JJ --> KK

    KK --> LL[Process Image if Attachment]
    LL --> MM[Upload to IPFS if Needed]
    MM --> NN[Calculate Fee Allocation]
    NN --> OO[Create Flaunch Transaction]

    OO --> PP[Encode Transaction Data]
    PP --> QQ[Set Pending Transaction State]
    QQ --> RR[Send WalletSendCalls]

    RR --> SS[User Signs Transaction]
    SS --> TT[Transaction Success]
    TT --> UU[Extract Manager Address if First Launch]
    UU --> VV[Update User Status to Active]
    VV --> WW[Ensure Group Exists for Chat Room]
    WW --> XX[Store Coin in All Group Members]
    XX --> YY[Update User States]
    YY --> ZZ[Clear Progress & Pending TX]

    N --> AAA[Extract Coin Data from Message]
    AAA --> BBB[Check If Complete]
    BBB --> CCC{Has All Data?}
    CCC -->|Yes| CC
    CCC -->|No| DD

    style A fill:#1565C0,color:#ffffff
    style O fill:#8E24AA,color:#ffffff
    style P fill:#D32F2F,color:#ffffff
    style R fill:#4CAF50,color:#ffffff
    style S fill:#4CAF50,color:#ffffff
    style T fill:#4CAF50,color:#ffffff
    style N fill:#7B1FA2,color:#ffffff
    style CC fill:#2E7D32,color:#ffffff
    style KK fill:#4CAF50,color:#ffffff
    style RR fill:#4CAF50,color:#ffffff
    style UU fill:#388E3C,color:#ffffff
    style VV fill:#388E3C,color:#ffffff
    style WW fill:#4CAF50,color:#ffffff
    style XX fill:#4CAF50,color:#ffffff
    style YY fill:#4CAF50,color:#ffffff
```

---

## 12. Attachment-Only Message Handling

This diagram shows the comprehensive fix for handling attachment-only messages during coin launch data collection, with dual-layer protection to prevent data loss.

```mermaid
graph TD
    A[User Sends Attachment-Only Message] --> B[EnhancedMessageCoordinator]
    B --> C[Message Queued & Processed]
    C --> D[Extract Combined Text - Empty/Minimal]
    D --> E[Route to FlowRouter]

    E --> F[FlowRouter.getPrimaryFlow]
    F --> G{PRIORITY 0: Existing Coin Launch Progress?}
    G -->|Yes| H[🛡️ PROTECTION LAYER 1]
    G -->|No| I[LLM Intent Classification]

    H --> J[Route to coin_launch Flow]
    J --> K[CoinLaunchFlow.processMessage]

    I --> L[Classified as "other" intent]
    L --> M[Route to qa Flow]
    M --> N[QAFlow.processMessage]

    N --> O[Extract Coin Launch Details]
    O --> P{Coin Launch Detected?}
    P -->|Yes| Q{🛡️ PROTECTION LAYER 2: Existing Progress?}
    P -->|No| R[Handle as General Q&A]

    Q -->|Yes| S[GUARD: Don't Override]
    Q -->|No| T[Create New Progress - BYPASSED]

    S --> U[Send Warning Message]
    U --> V["you already have a coin launch in progress!"]

    K --> W{In collecting_coin_data Step?}
    W -->|Yes| X{Attachment-Only Message?}
    W -->|No| Y[Normal Processing]

    X -->|Yes| Z[🎯 SPECIAL CASE HANDLER]
    X -->|No| AA[Extract Data from Text]

    Z --> BB[Update Image: "attachment_provided"]
    BB --> CC[Send Acknowledgment: "got the image! 📸"]
    CC --> DD[Check Data Completeness]

    DD --> EE{Has Name, Ticker, Image?}
    EE -->|Yes| FF[Launch Coin with Preserved Data]
    EE -->|No| GG[Request Missing Data]

    FF --> HH[✅ Success: Data Preserved]
    GG --> II[Continue Data Collection]

    style A fill:#1565C0,color:#ffffff
    style H fill:#D32F2F,color:#ffffff
    style J fill:#4CAF50,color:#ffffff
    style Q fill:#8E24AA,color:#ffffff
    style S fill:#D32F2F,color:#ffffff
    style V fill:#F57C00,color:#ffffff
    style Z fill:#2E7D32,color:#ffffff
    style BB fill:#4CAF50,color:#ffffff
    style CC fill:#4CAF50,color:#ffffff
    style FF fill:#388E3C,color:#ffffff
    style HH fill:#4CAF50,color:#ffffff
```

---

## 13. Complete System Architecture Overview

This diagram shows the overall system architecture and how all components interact with each other, including the sophisticated multi-intent detection, group-specific state management, and enhanced service integration.

```mermaid
graph TD
    A[XMTP Message Stream] --> B[EnhancedMessageCoordinator with 1s Coordination]
    B --> C[Message Filtering & Coordination with Thread Management]
    C --> D[FlowRouter with Multi-Intent Detection]
    D --> E[GPT-4o-mini Intent Classification]
    E --> F{Route to Flow with Priority System}

    F -->|Priority 0: Existing Progress| G[coin_launch - Continue with Attachment Support]
    F -->|Priority 1: High Confidence| H[qa - Status Inquiry with Live Data]
    F -->|Priority 2: Actions| I[coin_launch/management - Actions with Auto Group]
    F -->|Priority 3+: Fallback| J[qa - Help & Questions with DM Handling]

    G --> K[Handle Coin Launch with LLM Extraction]
    H --> L[Handle Questions & Status with Live Data]
    I --> M[Manage Groups & Launch Coins with Auto Creation]
    J --> N[Provide Help & Explanations with Context]

    O[SessionManager with Group States] --> P[FileStateStorage with Date Handling]
    P --> Q[user-states.json with GroupStates]

    R[Services Layer] --> S[GraphQLService - Chain-Specific Data]
    R --> T[UserDataService - Live Data Injection]
    R --> U[ENSResolverService - Batch Resolution]
    R --> V[GroupStorageService - Multi-User Management]

    S --> W[External API with Holdings Data]
    T --> X[Live Data Injection with Coin Discovery]
    U --> Y[ENS/Basename Resolution with Fallbacks]
    V --> Z[Multi-User State Management with Auto Status]

    AA[XMTPStatusMonitor] --> BB[RSS Feed Monitoring Every 5 Minutes]
    BB --> CC[Automatic Restart on Issues/Resolution]
    CC --> DD[Application Factory with Resource Management]
    DD --> EE[Recreate All Components with Monitoring]

    FF[InstallationManager] --> GG[XMTP Client Creation with Reuse]
    GG --> HH[Handle Installation Limits with Callbacks]
    HH --> II[Retry Logic & Fallbacks with Error Handling]

    K --> O
    L --> O
    M --> O
    N --> O

    K --> R
    L --> R
    M --> R
    N --> R

    JJ[Tools & Utilities] --> KK[Character System with Context]
    JJ --> LL[IPFS Upload with Error Handling]
    JJ --> MM[Transaction Utils with Flaunch Integration]
    JJ --> NN[ENS Resolution with Caching]

    K --> JJ
    M --> JJ
    N --> JJ

    OO[External Systems] --> PP[Flaunch Protocol with Auto Group Creation]
    OO --> QQ[Base/Sepolia Networks with Chain Selection]
    OO --> RR[IPFS Storage with Fallbacks]
    OO --> SS[XMTP Network with Status Monitoring]

    TT[Enhanced Features] --> UU[Multi-Intent Detection]
    TT --> VV[Group-Specific State Management]
    TT --> WW[Live Data Integration]
    TT --> XX[Sophisticated Message Coordination]
    TT --> YY[Direct Message Handling]

    style A fill:#1565C0,color:#ffffff
    style B fill:#7B1FA2,color:#ffffff
    style D fill:#F57C00,color:#ffffff
    style G fill:#4CAF50,color:#ffffff
    style O fill:#2E7D32,color:#ffffff
    style R fill:#4CAF50,color:#ffffff
    style AA fill:#8E24AA,color:#ffffff
    style FF fill:#FFA726,color:#ffffff
    style OO fill:#607D8B,color:#ffffff
    style TT fill:#FF9800,color:#ffffff
```

---

## Key System Features

### Advanced Message Coordination

- **1-second wait time** to coordinate text + image messages with sophisticated queuing
- **Smart queuing** system for related messages with attachment synchronization
- **Automatic retry** logic for failed coordination with graceful degradation
- **Attachment-only message handling** with dual-layer protection and special case handling
- **Combined message text extraction** from primary and related messages
- **Thread management** with active thread tracking and timeout handling (5 minutes)

### Sophisticated Message Filtering

- **Context-aware filtering** with special handling for coin launch progress
- **Reply detection** with distinction between agent replies and user replies
- **Explicit mention detection** with @-symbol and obvious mention patterns
- **Non-text reply handling** for reactions and other content types
- **Image-only message processing** during coin data collection phases
- **Simplified engagement detection** with cost-effective LLM usage

### Multi-Intent Detection & Priority-Based Routing

- **GPT-4o-mini powered intent classification** with confidence scoring
- **Primary and secondary intent detection** for comprehensive message understanding
- **Critical coin launch pattern recognition** with context-aware classification
- **Priority 0 (HIGHEST)**: Continue existing coin launch progress (attachment support)
- **Priority 1**: High-confidence status inquiries with live data
- **Priority 2**: Action intents (coin launch with auto group, modifications)
- **Priority 3+**: Questions, management, social interactions, fallback handling

### Enhanced Direct Message Handling

- **Smart flow-based routing** for 1-on-1 conversations with intent detection
- **Live data fetching** for groups/coins status queries in DMs
- **Context-aware responses** with structured guidance for group requirements
- **Capability and general question handling** with character voice
- **Management and coin launch flow blocking** with clear instructions
- **No user state updates** for blocked direct message interactions
- **Consistent structured responses** with step-by-step group creation guidance

### Advanced State Management

- **Group-specific state management** with per-conversation state tracking
- **FileStateStorage** with sophisticated date handling and JSON serialization
- **Live data injection** from blockchain APIs for all users with coins/groups
- **Automatic user status updates** from "new" to "active" after successful operations
- **Multi-user group management** with automatic state sharing and invitation handling
- **Coin discovery** from blockchain data with automatic state updates

### Comprehensive Transaction Processing

- **Enhanced transaction reference handling** with comprehensive null checks
- **Robust error handling** with detailed logging and fallback responses
- **Automatic manager address extraction** for first launches in chat rooms
- **Proper coin storage** for all group members after successful launch
- **Transaction modification support** with LLM-powered parameter updates
- **Cross-flow transaction clearing** to prevent state conflicts

### Intelligent Service Integration

- **GraphQLService** with chain-specific data support and holdings information
- **UserDataService** with live data injection and coin discovery from blockchain
- **ENSResolverService** with batch resolution and ENS/Basename support
- **GroupStorageService** with multi-user management and automatic status updates
- **XMTPStatusMonitor** with RSS feed monitoring and automatic restart capabilities

### Enhanced Flow Processing

- **QA Flow**:

  - Direct message handling with live data for groups/coins queries
  - Protection against overriding existing coin launch progress
  - Capability and general question handling with context
  - Multiple coin request detection and handling

- **Management Flow**:

  - Transaction intent classification (cancel, modify, inquiry)
  - Live data integration for group and coin listings
  - Sophisticated parameter modification with LLM extraction
  - Invited user welcome handling

- **Coin Launch Flow**:
  - Attachment-only message handling during data collection
  - LLM-powered coin data extraction with validation
  - Automatic group creation for chat room members
  - Launch options and status inquiry handling
  - Special case handling for image-only messages

### Advanced Installation & Monitoring

- **XMTP client reuse** to avoid hitting installation limits
- **Installation limit handling** with callbacks and retry logic
- **Automatic restart** on XMTP status issues (5-minute intervals)
- **Graceful cleanup** and resource management
- **RSS feed monitoring** with critical incident detection
- **Application factory pattern** for resource recreation

### Production-Ready Features

- **Error handling** with fallback responses and graceful degradation
- **Logging** with detailed debugging information and structured output
- **Performance optimization** with simplified engagement detection
- **Cost optimization** with strategic LLM usage
- **Chain support** for Base and Base Sepolia networks
- **IPFS integration** with error handling and fallbacks
- **Character system** with context-aware responses

## Debugging Guide

When debugging issues, refer to these diagrams to understand:

1. **Message not being processed**: Check diagram #4 (Message Filtering) - focus on coin launch progress detection and engagement filtering
2. **Flow routing issues**: Check diagram #5 (Flow Router & Intent Classification) - examine multi-intent detection and priority system
3. **State persistence problems**: Check diagram #6 (User State Management) - verify group-specific state handling
4. **Restart/connection issues**: Check diagram #2 (Status Monitor) - check RSS feed monitoring and restart logic
5. **Transaction handling**: Check diagram #11 (Coin Launch Flow) and #3 (Transaction Reference Processing) - verify null checks and processing
6. **Direct message handling**: Check diagram #8 (Direct Message Handling System) - examine intent detection and live data fetching
7. **Service integration issues**: Check diagram #9 (Services Architecture) - verify GraphQL, UserData, ENS, and GroupStorage services
8. **Complete system flow**: Check diagram #13 (Complete System Architecture) - understand overall component interaction

### Message Coordination Debugging

- **Messages not coordinating**: Check 1-second timer and message queuing logic
- **Attachment-only messages ignored**: Verify special case handling in message filtering
- **Combined text extraction failing**: Check extractCombinedMessageText function
- **Thread management issues**: Verify active thread tracking and timeout logic (5 minutes)
- **Non-text reply handling**: Check filtering for reactions and other content types

### Multi-Intent Detection Debugging

- **Wrong intent classification**: Check GPT-4o-mini prompt and response parsing
- **Primary intent incorrect**: Verify confidence scoring and intent validation
- **Secondary intents ignored**: Check if secondary intents are being processed
- **Coin launch patterns not detected**: Verify critical pattern recognition in prompt
- **Priority routing bypassed**: Check priority 0-3+ logic in getPrimaryFlow

### Enhanced State Management Debugging

- **Group-specific state issues**: Check if groupStates[groupId] is being created/updated
- **FileStateStorage errors**: Verify JSON serialization and date handling
- **Live data not injecting**: Check if user has coins/groups and API calls are working
- **Coin discovery failing**: Verify GraphQL API responses and data parsing
- **User status not updating**: Check status transition logic from "new" to "active"
- **Multi-user group issues**: Verify all receiver addresses are being processed

### Direct Message Handling Debugging

- **DM flow routing wrong**: Check intent detection and management/coin launch blocking
- **Live data not fetching**: Verify groups/coins query detection and API calls
- **Structured responses not sent**: Check group requirement message logic
- **Context-aware responses failing**: Verify capability and general question handling
- **Status queries not working**: Check getUserStateWithLiveData integration

### Service Integration Debugging

- **GraphQL API issues**: Check chain-specific headers and query formatting
- **UserData service errors**: Verify live data injection and coin discovery logic
- **ENS resolution failing**: Check batch resolution and fallback to shortened addresses
- **GroupStorage problems**: Verify multi-user management and automatic status updates
- **StatusMonitor not working**: Check RSS feed parsing and restart logic

### Flow Processing Debugging

- **QA Flow issues**:

  - DM handling not working: Check direct message detection and live data fetching
  - Coin launch progress override: Verify guard clause protection
  - Multiple coin detection: Check multiple coin request handling
  - Status inquiry errors: Verify live data integration

- **Management Flow issues**:

  - Transaction intent classification: Check LLM-powered intent detection
  - Parameter modification: Verify LLM extraction and validation
  - Invited user handling: Check welcome message logic
  - Live data integration: Verify GraphQL API calls

- **Coin Launch Flow issues**:
  - Attachment-only handling: Check special case handler during data collection
  - LLM extraction failing: Verify coin data extraction and validation
  - Auto group creation: Check chat room member detection and group setup
  - Launch options: Verify inquiry type handling

### Installation & Monitoring Debugging

- **Client reuse failing**: Check buildExistingClient vs createClient logic
- **Installation limit hit**: Verify callback handling and retry logic
- **Restart not triggering**: Check RSS feed monitoring and incident detection
- **Resource cleanup issues**: Verify graceful cleanup and resource management
- **Factory pattern errors**: Check application resource recreation logic

### Performance & Cost Debugging

- **Excessive LLM calls**: Check simplified engagement detection and strategic usage
- **Slow response times**: Verify message coordination timing and processing
- **Memory leaks**: Check resource cleanup and state management
- **API rate limiting**: Verify GraphQL and ENS service call patterns
- **Storage performance**: Check FileStateStorage read/write operations

Each diagram provides the logical flow to trace through when investigating specific types of issues. The enhanced system includes comprehensive error handling, detailed logging, and fallback mechanisms to ensure reliable operation.
