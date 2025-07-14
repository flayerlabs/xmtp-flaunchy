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
12. [Complete System Architecture Overview](#12-complete-system-architecture-overview)

---

## 1. Application Initialization & Main Flow

This diagram shows the complete startup process from environment loading to the message processing loop, including XMTP client creation and component initialization.

```mermaid
graph TD
    A[Start Application] --> B[Load Environment Variables]
    B --> C[Create OpenAI Client]
    C --> D[Create Signer & Encryption Key]
    D --> E[Try Reuse Existing XMTP Installation]

    E --> F{Installation Exists?}
    F -->|Yes| G[InstallationManager.buildExistingClient]
    F -->|No| H[InstallationManager.createClient]

    G --> I{Client Creation Success?}
    H --> J{Hit Installation Limit?}
    J -->|Yes| K[onInstallationLimitExceeded Callback]
    J -->|No| I
    I -->|No| H

    I -->|Yes| L[Initialize Core Components]
    L --> M[FileStateStorage - user-states.json]
    L --> N[SessionManager]
    L --> O[Flow Registry - QA, Management, CoinLaunch]
    L --> P[FlowRouter]
    L --> Q[EnhancedMessageCoordinator]
    L --> R[XMTPStatusMonitor]

    M --> S[Sync Conversations]
    N --> S
    O --> S
    P --> S
    Q --> S
    R --> S

    S --> T[Start Message Stream]
    T --> U[Create Status Monitor]
    U --> V[Start With Monitoring]
    V --> W[Begin Message Processing Loop]

    W --> X[Listen for Messages]
    X --> Y[Process Each Message]
    Y --> Z[messageCoordinator.processMessage]
    Z --> X

    style A fill:#e1f5fe
    style L fill:#f3e5f5
    style S fill:#e8f5e8
    style W fill:#fff3e0
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

    style A fill:#e1f5fe
    style P fill:#ffebee
    style U fill:#fff3e0
    style J fill:#f3e5f5
```

---

## 3. Enhanced Message Coordinator - Message Processing

This diagram illustrates how messages are received, coordinated (text + attachments), and queued for processing with proper timing, including direct message handling.

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
    G -->|Yes| H[handleTransactionReference]
    G -->|No| I{Skip Transaction Receipts '...'?}
    I -->|Yes| D
    I -->|No| J[Determine Message Type]

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

    V --> W[Get Primary Message]
    W --> X[Get Related Messages]
    X --> Y[Get Conversation & Sender Info]
    Y --> Z[Check Member Count]

    Z --> AA{Is Direct Message?}
    AA -->|Yes| BB[Detect Intent with FlowRouter]
    AA -->|No| CC[Get User State by Address]

    BB --> DD{Management/Coin Launch?}
    DD -->|Yes| EE[Send Group Requirement Message]
    DD -->|No| FF[Continue to QA Flow]

    EE --> GG[Return true - DM Handled]
    FF --> CC

    CC --> HH[shouldProcessMessage]
    HH --> II{Should Process?}
    II -->|No| JJ[Return false]
    II -->|Yes| KK[Send Paw Reaction 🐾]

    KK --> LL[createFlowContext with isDirectMessage]
    LL --> MM[Extract Message Text & Attachments]
    MM --> NN[Create Helper Functions]
    NN --> OO[flowRouter.routeMessage]

    style A fill:#e1f5fe
    style V fill:#f3e5f5
    style AA fill:#fff3e0
    style EE fill:#ffebee
    style OO fill:#e8f5e8
```

---

## 4. Enhanced Message Coordinator - Message Filtering

This diagram shows the sophisticated filtering system that determines whether to process messages in group chats based on mentions, replies, and active threads.

```mermaid
graph TD
    A[shouldProcessMessage] --> B{Is Group Chat?}
    B -->|No| C[Always Process - 1:1 Chat]
    B -->|Yes| D[Extract Combined Message Text]

    D --> E[isReplyToAgentMessage]
    E --> F{Reply to Agent?}
    F -->|Yes| G[Update Active Thread]
    G --> H[Return true - High Confidence]

    F -->|No| I{Is Reply to Other User?}
    I -->|Yes| J[detectExplicitAgentMention]
    J --> K{Has @mention?}
    K -->|No| L[Return false - Ignore]
    K -->|Yes| M[Process with Mention]

    I -->|No| N[detectObviousAgentMention]
    N --> O{Obvious Mention?}
    O -->|Yes| P[Update Active Thread]
    P --> Q[Return true - Obvious]

    O -->|No| R[checkConversationEngagement - LLM]
    R --> S{LLM Detects Engagement?}
    S -->|Yes| T[Update Active Thread]
    T --> U[Return true - LLM Detected]

    S -->|No| V[isInActiveThread]
    V --> W{In Active Thread?}
    W -->|Yes| X[Update Thread Activity]
    X --> Y[Return true - Continue Thread]

    W -->|No| Z[Return false - Ignore]

    style A fill:#e1f5fe
    style F fill:#f3e5f5
    style S fill:#fff3e0
    style V fill:#e8f5e8
```

---

## 5. Flow Router & Intent Classification

This diagram documents the LLM-based intent classification system that routes messages to appropriate flows based on user intent and context.

```mermaid
graph TD
    A[FlowRouter.routeMessage] --> B{Skip '...' Messages?}
    B -->|Yes| C[Return - Transaction Receipt]
    B -->|No| D[detectMultipleIntents]

    D --> E[Build Context Prompt]
    E --> F[User Status, Groups, Coins, Pending TX]
    F --> G[GPT-4o-mini Classification]

    G --> H[Parse Primary Intent]
    H --> I[Parse Secondary Intents]
    I --> J[Parse Flags]

    J --> K[Validate & Sanitize Results]
    K --> L[getPrimaryFlow]

    L --> M{Primary Intent Type?}
    M -->|inquiry + high confidence| N[QA Flow]
    M -->|action| O{Action Type?}
    M -->|question| P[QA Flow]
    M -->|management| Q[Management Flow]
    M -->|social/greeting| R[QA Flow - Explain]
    M -->|other/unknown| S[QA Flow - Help]

    O -->|coin_launch| T[Coin Launch Flow]
    O -->|modify_existing| U{Pending TX Type?}

    U -->|coin_creation| V[Coin Launch Flow]
    U -->|group_creation| W[Management Flow]
    U -->|none| X[Management Flow]

    T --> Y[Add Multi-Intent to Context]
    V --> Y
    W --> Y
    N --> Y
    P --> Y
    Q --> Y
    R --> Y
    S --> Y

    Y --> Z[Execute Flow.processMessage]

    style A fill:#e1f5fe
    style D fill:#f3e5f5
    style L fill:#fff3e0
    style Z fill:#e8f5e8
```

---

## 6. User State Management & Storage

This diagram explains how user data is stored in `user-states.json`, including state creation, updates, and multi-user group management.

```mermaid
graph TD
    A[User Message] --> B[Get Creator Address from InboxId]
    B --> C[SessionManager.getUserState]

    C --> D[FileStateStorage.get]
    D --> E{User State Exists?}
    E -->|No| F[createNewUserState]
    E -->|Yes| G[Load from user-states.json]

    F --> H[Initialize New User]
    H --> I[Status: 'new']
    I --> J[Empty Groups & Coins Arrays]
    J --> K[Default Preferences]
    K --> L[Save to Storage]

    G --> M[Parse JSON & Convert Dates]
    M --> N[Return User State]

    L --> O[User State Available]
    N --> O

    O --> P[Flow Processing]
    P --> Q[SessionManager.updateUserState]
    Q --> R[Merge Updates with Current State]
    R --> S[Set updatedAt = now]
    S --> T[FileStateStorage.set]

    T --> U[Convert to JSON]
    U --> V[Write to user-states.json]

    W[GroupStorageService] --> X[Add Groups to All Members]
    X --> Y[Iterate All Receiver Addresses]
    Y --> Z[Get/Create User State for Each]
    Z --> AA[Add Group to Each User]
    AA --> BB[Update Status to 'invited']

    CC[UserDataService] --> DD[Inject Live API Data]
    DD --> EE[Fetch from GraphQL API]
    EE --> FF[Update Groups with Live Data]
    FF --> GG[Update Coins with Live Data]
    GG --> HH[Return Enriched State]

    style A fill:#e1f5fe
    style F fill:#f3e5f5
    style T fill:#fff3e0
    style CC fill:#e8f5e8
```

---

## 7. Flow Processing System

This diagram shows how the three main flows (QA, Management, Coin Launch) process different types of user messages and handle various scenarios.

```mermaid
graph TD
    A[FlowRouter Routes to Flow] --> B{Which Flow?}

    B -->|QA Flow| C[QAFlow.processMessage]
    B -->|Management Flow| D[ManagementFlow.processMessage]
    B -->|Coin Launch Flow| E[CoinLaunchFlow.processMessage]

    C --> F{Is Direct Message?}
    F -->|Yes| G[Send Structured Group Requirement Message]
    F -->|No| H[Check Multiple Coin Request]

    H --> I{Multiple Coins?}
    I -->|Yes| J[Handle Multiple Coin Request]
    I -->|No| K[Check Existing Groups]

    K --> L{User Has Groups?}
    L -->|Yes| M[Extract Coin Launch Details]
    M --> N{Coin Launch Detected?}
    N -->|Yes| O[Initialize Coin Launch Progress]
    N -->|No| P[Classify Question Type]

    P --> Q{Question Type?}
    Q -->|Capability| R[Handle Capability Question]
    Q -->|Status| S[Handle Status Inquiry]
    Q -->|General| T[Handle General Question]

    D --> U{User Status?}
    U -->|invited| V[Handle Invited User Welcome]
    U -->|other| W[Clear Cross-Flow Transactions]

    W --> X{Pending Transaction?}
    X -->|Yes| Y[Handle Pending Transaction]
    X -->|No| Z{Management Progress?}

    Z -->|Yes| AA[Handle Ongoing Process]
    Z -->|No| BB[Classify Management Action]

    BB --> CC{Action Type?}
    CC -->|list_groups| DD[List Groups]
    CC -->|list_coins| EE[List Coins]
    CC -->|claim_fees| FF[Claim Fees]
    CC -->|check_fees| GG[Check Fees]
    CC -->|cancel_transaction| HH[Cancel Transaction]
    CC -->|general_help| II[General Help]

    E --> JJ[Clear Cross-Flow Transactions]
    JJ --> KK{Pending Transaction?}
    KK -->|Yes| LL[Handle Pending Transaction Update]
    KK -->|No| MM{Coin Launch Progress?}

    MM -->|Yes| NN[Continue From Progress]
    MM -->|No| OO[Start New Coin Launch]

    OO --> PP[Extract Coin Data]
    PP --> QQ{Has All Data?}
    QQ -->|Yes| RR[Launch Coin]
    QQ -->|No| SS[Request Missing Data]

    style A fill:#e1f5fe
    style C fill:#f3e5f5
    style D fill:#fff3e0
    style E fill:#e8f5e8
    style G fill:#ffebee
```

---

## 8. Direct Message Handling System

This diagram shows how the system handles direct messages (1-on-1 conversations) differently from group chats, with smart routing for status inquiries and structured guidance for blocked functionality.

```mermaid
graph TD
    A[Direct Message Received] --> B[EnhancedMessageCoordinator]
    B --> C[Detect Intent with FlowRouter]
    C --> D[Classify Message Intent]

    D --> E{Intent Type?}
    E -->|Management| F[Block with Group Requirement]
    E -->|Coin Launch| G[Block with Group Requirement]
    E -->|QA/General| H[Allow QA Flow Processing]

    F --> I[Send Structured Message]
    G --> I
    H --> J[QAFlow.processMessage]

    I --> K[Structured Response:<br/>1. Create group chat<br/>2. Add bot to group<br/>3. Launch coins together]

    J --> L{Question Type?}
    L -->|Capability| M[Send Structured Message]
    L -->|Status| N{Groups/Coins Query?}
    L -->|General| M

    N -->|Yes| O[Fetch Live Data from API]
    N -->|No| M

    O --> P[SessionManager.getUserStateWithLiveData]
    P --> Q[UserDataService.injectGroupData]
    Q --> R[GraphQLService.fetchGroupData]
    R --> S[Display Actual Groups/Coins Data]

    M --> T[Same Structured Response:<br/>Bot works in groups only]

    U[Group Chat] --> V[Normal Flow Processing]
    V --> W[Full Functionality Available]
    W --> X[User State Updates]
    W --> Y[Coin Launch Capability]
    W --> Z[Management Features]

    style A fill:#e1f5fe
    style F fill:#ffebee
    style G fill:#ffebee
    style K fill:#fff3e0
    style O fill:#e8f5e8
    style S fill:#c8e6c9
    style U fill:#e8f5e8
```

---

## 9. Services Architecture & Integration

This diagram illustrates how all the services (GraphQL, UserData, ENS, GroupStorage, StatusMonitor) work together to provide functionality.

```mermaid
graph TD
    A[Service Layer] --> B[GraphQLService]
    A --> C[UserDataService]
    A --> D[ENSResolverService]
    A --> E[GroupStorageService]
    A --> F[XMTPStatusMonitor]

    B --> G[Fetch Group Data from API]
    G --> H[Query addressFeeSplitManagers]
    H --> I[Get Live Token Data]
    I --> J[Get Fee Information]
    J --> K[Return Structured Data]

    C --> L[Inject Live Data into User State]
    L --> M[Use GraphQLService]
    M --> N[Enrich Groups with Live Data]
    N --> O[Enrich Coins with Live Data]
    O --> P[Return Updated State]

    D --> Q[Resolve ENS Names]
    Q --> R[Batch Address Resolution]
    R --> S[Query API for ENS Data]
    S --> T[Return Display Names]
    T --> U[Fallback to Shortened Addresses]

    E --> V[Store Groups for All Members]
    V --> W[Get All Receiver Addresses]
    W --> X[Create User States if Needed]
    X --> Y[Add Group to Each User]
    Y --> Z[Mark New Users as 'invited']

    F --> AA[Monitor XMTP Status]
    AA --> BB[Fetch RSS Feed]
    BB --> CC[Parse Status Updates]
    CC --> DD[Check for Issues]
    DD --> EE{Issues Found?}
    EE -->|Yes| FF[Trigger Application Restart]
    EE -->|No| GG[Continue Monitoring]

    HH[Flow Context] --> B
    HH --> C
    HH --> D
    HH --> E

    style A fill:#e1f5fe
    style HH fill:#f3e5f5
    style B fill:#fff3e0
    style C fill:#e8f5e8
    style D fill:#f1f8e9
    style E fill:#fce4ec
    style F fill:#fff8e1
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

    style A fill:#e1f5fe
    style C fill:#f3e5f5
    style K fill:#fff3e0
    style V fill:#ffebee
    style O fill:#e8f5e8
```

---

## 11. Coin Launch Flow - Detailed Process

This diagram provides a detailed breakdown of the coin launch process, from message extraction to transaction creation.

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

    N --> O[Extract Coin Data from Message]
    O --> P[LLM Extraction using GPT-4o-mini]
    P --> Q[Parse Token Details]
    Q --> R[Parse Launch Parameters]
    R --> S[Validate Extracted Data]

    S --> T{Has Name, Ticker, Image?}
    T -->|Yes| U[Get Chat Room Manager Address]
    T -->|No| V[Request Missing Data]

    U --> W{First Launch in Chat?}
    W -->|Yes| X[Create Initialize Data]
    W -->|No| Y[Use Existing Manager]

    X --> Z[Get All Chat Members]
    Z --> AA[Create Fee Split Data]
    AA --> BB[Encode ABI Parameters]

    Y --> CC[Launch Coin]
    BB --> CC

    CC --> DD[Process Image if Attachment]
    DD --> EE[Upload to IPFS if Needed]
    EE --> FF[Calculate Fee Allocation]
    FF --> GG[Create Flaunch Transaction]

    GG --> HH[Encode Transaction Data]
    HH --> II[Set Pending Transaction State]
    II --> JJ[Send WalletSendCalls]

    JJ --> KK[User Signs Transaction]
    KK --> LL[Transaction Success]
    LL --> MM[Store Coin in All Group Members]
    MM --> NN[Update User States]
    NN --> OO[Clear Progress & Pending TX]

    M --> PP[Check Progress Step]
    PP --> QQ{Step Type?}
    QQ -->|collecting_coin_data| RR[Request Missing Info]
    QQ -->|selecting_group| SS[Show Group Options]
    QQ -->|creating_transaction| TT[Build Transaction]

    style A fill:#e1f5fe
    style N fill:#f3e5f5
    style U fill:#fff3e0
    style CC fill:#e8f5e8
    style JJ fill:#f1f8e9
```

---

## 12. Complete System Architecture Overview

This diagram shows the overall system architecture and how all components interact with each other.

```mermaid
graph TD
    A[XMTP Message Stream] --> B[EnhancedMessageCoordinator]
    B --> C[Message Filtering & Coordination]
    C --> D[FlowRouter]
    D --> E[Intent Classification via LLM]
    E --> F{Route to Flow}

    F -->|QA| G[QAFlow]
    F -->|Management| H[ManagementFlow]
    F -->|Coin Launch| I[CoinLaunchFlow]

    G --> J[Handle Questions & Explanations]
    H --> K[Manage Groups & Coins]
    I --> L[Launch New Coins]

    M[SessionManager] --> N[FileStateStorage]
    N --> O[user-states.json]

    P[Services Layer] --> Q[GraphQLService]
    P --> R[UserDataService]
    P --> S[ENSResolverService]
    P --> T[GroupStorageService]

    Q --> U[External API]
    R --> V[Live Data Injection]
    S --> W[ENS Resolution]
    T --> X[Multi-User State Management]

    Y[XMTPStatusMonitor] --> Z[RSS Feed Monitoring]
    Z --> AA[Automatic Restart on Issues]
    AA --> BB[Application Factory]
    BB --> CC[Recreate All Components]

    DD[InstallationManager] --> EE[XMTP Client Creation]
    EE --> FF[Handle Installation Limits]
    FF --> GG[Retry Logic & Fallbacks]

    G --> M
    H --> M
    I --> M

    J --> P
    K --> P
    L --> P

    HH[Tools & Utilities] --> II[Character System]
    HH --> JJ[IPFS Upload]
    HH --> KK[Transaction Utils]
    HH --> LL[ENS Resolution]

    I --> HH
    H --> HH
    G --> HH

    MM[External Systems] --> NN[Flaunch Protocol]
    MM --> OO[Base/Sepolia Networks]
    MM --> PP[IPFS Storage]
    MM --> QQ[XMTP Network]

    style A fill:#e1f5fe
    style B fill:#f3e5f5
    style D fill:#fff3e0
    style M fill:#e8f5e8
    style P fill:#f1f8e9
    style Y fill:#fce4ec
    style DD fill:#fff8e1
    style MM fill:#f5f5f5
```

---

## Key System Features

### Message Coordination

- **1-second wait time** to coordinate text + image messages
- **Smart queuing** system for related messages
- **Automatic retry** logic for failed coordination

### Smart Filtering

- Only responds in group chats when **explicitly mentioned** or in **active threads**
- **LLM-powered engagement detection** for edge cases
- **Thread timeout management** (5 minutes of inactivity)

### Direct Message Handling

- **Smart flow-based routing** for 1-on-1 conversations
- **QA Flow messages** (greetings, questions, help) are allowed but provide structured guidance
- **Groups/Coins status queries** in DMs now fetch and display real data from GraphQL API
- **Management and Coin Launch flows** are blocked with group requirement message
- **No user state updates** for blocked direct message interactions
- **Consistent structured responses** with clear step-by-step instructions
- **Live data integration** for status inquiries about user's groups and coins

### State Management

- **Persistent user states** stored in `user-states.json`
- **Live data injection** from external APIs
- **Multi-user group management** with automatic state sharing

### Automatic Restart

- **Monitors XMTP status** via RSS feed every 5 minutes
- **Automatic restart** on critical issues or when issues are resolved
- **Graceful cleanup** and resource management

### Multi-Flow Architecture

- **QA Flow**: Handles questions, explanations, and help requests (with DM awareness and live data for groups/coins queries)
- **Management Flow**: Manages existing groups, coins, and transactions (group chats only)
- **Coin Launch Flow**: Handles new coin creation with automatic group setup (group chats only)

### Installation Limit Handling

- **Graceful handling** of XMTP's 5-installation limit
- **Retry logic** with exponential backoff
- **Fallback strategies** and error notifications

### Service Integration

- **External API calls** for live data
- **ENS resolution** for user-friendly addresses
- **Multi-user management** for group operations
- **IPFS integration** for image storage

## Debugging Guide

When debugging issues, refer to these diagrams to understand:

1. **Message not being processed**: Check diagram #4 (Message Filtering)
2. **Flow routing issues**: Check diagram #5 (Flow Router & Intent Classification)
3. **State persistence problems**: Check diagram #6 (User State Management)
4. **Restart/connection issues**: Check diagram #2 (Status Monitor)
5. **Transaction handling**: Check diagram #11 (Coin Launch Flow)
6. **Direct message handling**: Check diagram #8 (Direct Message Handling System)
7. **QA Flow responses in DMs**: Check diagram #7 (Flow Processing System) and #8 (Direct Message Handling)

### Direct Message Debugging

- **DM blocked incorrectly**: Check if intent detection is working properly in MessageCoordinator
- **DM allowed incorrectly**: Verify QA Flow is detecting `context.isDirectMessage` properly
- **Wrong DM response**: Check if structured response is being used instead of LLM-generated content
- **User state updated in DM**: Ensure blocked flows return early without state updates
- **Groups/Coins queries not showing data**: Check if `detectGroupsOrCoinsQuery` is working and API calls are succeeding
- **LLM detection failing**: Ensure LLM responses are parsed correctly (handle "yes." vs "yes")

Each diagram provides the logical flow to trace through when investigating specific types of issues.
