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

    style A fill:#1565C0,color:#ffffff
    style L fill:#7B1FA2,color:#ffffff
    style S fill:#2E7D32,color:#ffffff
    style W fill:#F57C00,color:#ffffff
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
    I -->|No| J[Determine Message Type]

    H --> H1[Check Message Content]
    H1 --> H2{Content Exists?}
    H2 -->|No| H3[Log Error & Return false]
    H2 -->|Yes| H4[Check Transaction Reference]
    H4 --> H5{Transaction Ref Exists?}
    H5 -->|No| H3
    H5 -->|Yes| H6[Check TX Hash]
    H6 --> H7{TX Hash Exists?}
    H7 -->|No| H3
    H7 -->|Yes| H8[Process Transaction]
    H8 --> H9[Update User Status to Active]
    H9 --> H10[Ensure Group Exists for Chat Room]
    H10 --> H11[Store Coin for All Members]

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

    style A fill:#1565C0,color:#ffffff
    style V fill:#7B1FA2,color:#ffffff
    style AA fill:#F57C00,color:#ffffff
    style EE fill:#D32F2F,color:#ffffff
    style H fill:#8E24AA,color:#ffffff
    style H8 fill:#2E7D32,color:#ffffff
    style H9 fill:#388E3C,color:#ffffff
    style H10 fill:#388E3C,color:#ffffff
    style H11 fill:#388E3C,color:#ffffff
    style OO fill:#2E7D32,color:#ffffff
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

    style A fill:#1565C0,color:#ffffff
    style F fill:#D32F2F,color:#ffffff
    style G fill:#D32F2F,color:#ffffff
    style K fill:#F57C00,color:#ffffff
    style P fill:#2E7D32,color:#ffffff
    style R fill:#388E3C,color:#ffffff
    style S fill:#388E3C,color:#ffffff
    style T fill:#388E3C,color:#ffffff
    style U fill:#4CAF50,color:#ffffff
    style V fill:#4CAF50,color:#ffffff
    style W fill:#4CAF50,color:#ffffff
    style X fill:#4CAF50,color:#ffffff
    style Z fill:#2E7D32,color:#ffffff
```

---

## 5. Flow Router & Intent Classification

This diagram documents the updated LLM-based intent classification system that routes messages to appropriate flows based on user intent and context, with priority handling for existing coin launch progress.

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

    L --> M{PRIORITY 0: Existing Coin Launch?}
    M -->|Yes| N[coin_launch - Continue Progress]
    M -->|No| O{PRIORITY 1: High Confidence Status?}

    O -->|Yes| P[QA Flow - Status Inquiry]
    O -->|No| Q{PRIORITY 2: Action Type?}

    Q -->|coin_launch| R[coin_launch - New Launch]
    Q -->|modify_existing| S{Modify What?}
    Q -->|other| T[Continue to Lower Priority]

    S -->|coin_creation| U[coin_launch - Modify Coin]
    S -->|group_creation| V[management - Modify Group]
    S -->|none| W[management - General]

    T --> X{PRIORITY 3: Question Type?}
    X -->|inquiry| Y[QA Flow - General Questions]
    X -->|other| Z{PRIORITY 4: Management?}

    Z -->|management/cancel| AA[management - Tasks]
    Z -->|other| BB{PRIORITY 5: Social?}

    BB -->|social/greeting| CC[QA Flow - Explain Agent]
    BB -->|other| DD[QA Flow - Help & Fallback]

    N --> EE[Add Multi-Intent to Context]
    P --> EE
    R --> EE
    U --> EE
    V --> EE
    W --> EE
    Y --> EE
    AA --> EE
    CC --> EE
    DD --> EE

    EE --> FF[Execute Flow.processMessage]

    style A fill:#1565C0,color:#ffffff
    style D fill:#7B1FA2,color:#ffffff
    style L fill:#F57C00,color:#ffffff
    style M fill:#D32F2F,color:#ffffff
    style N fill:#4CAF50,color:#ffffff
    style FF fill:#2E7D32,color:#ffffff
```

---

## 6. User State Management & Storage

This diagram explains how user data is stored in `user-states.json`, including state creation, updates, multi-user group management, and improved live data injection.

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

    CC[UserDataService] --> DD[Inject Live Data]
    DD --> EE[Fetch from GraphQL API]
    EE --> FF[Update Groups with Live Data]
    FF --> GG[Update Coins with Live Data]
    GG --> HH[Return Enriched State]

    II[SessionManager.getUserStateWithLiveData] --> JJ{User has Groups or Coins?}
    JJ -->|Yes| KK[Inject Live Data Regardless of Status]
    JJ -->|No| LL[Return State Without Live Data]

    KK --> MM[Log: Injecting Live Data]
    MM --> NN[Call UserDataService.injectGroupData]
    NN --> OO[Save Enriched State to Storage]
    OO --> PP[Return Enriched State]

    QQ[Coin Launch Success] --> RR[Update User Status]
    RR --> SS{User Status 'new' or 'onboarding'?}
    SS -->|Yes| TT[Update to 'active']
    SS -->|No| UU[Keep Current Status]

    TT --> VV[Send Completion Message]
    VV --> WW[User Now Active]

    style A fill:#1565C0,color:#ffffff
    style F fill:#7B1FA2,color:#ffffff
    style T fill:#F57C00,color:#ffffff
    style CC fill:#2E7D32,color:#ffffff
    style II fill:#388E3C,color:#ffffff
    style JJ fill:#388E3C,color:#ffffff
    style KK fill:#4CAF50,color:#ffffff
    style QQ fill:#8E24AA,color:#ffffff
    style RR fill:#AD1457,color:#ffffff
    style TT fill:#388E3C,color:#ffffff
```

---

## 7. Flow Processing System

This diagram shows how the three main flows (QA, Management, Coin Launch) process different types of user messages and handle various scenarios, with updated QA Flow protection against overriding existing progress.

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
    N -->|Yes| O{Existing Coin Launch Progress?}
    N -->|No| P[Classify Question Type]

    O -->|Yes| Q[GUARD: Don't Override - Send Warning]
    O -->|No| R[Initialize Coin Launch Progress]

    P --> S{Question Type?}
    S -->|Capability| T[Handle Capability Question]
    S -->|Status| U[Handle Status Inquiry]
    S -->|General| V[Handle General Question]

    D --> W{User Status?}
    W -->|invited| X[Handle Invited User Welcome]
    W -->|other| Y[Clear Cross-Flow Transactions]

    Y --> Z{Pending Transaction?}
    Z -->|Yes| AA[Handle Pending Transaction]
    Z -->|No| BB{Management Progress?}

    BB -->|Yes| CC[Handle Ongoing Process]
    BB -->|No| DD[Classify Management Action]

    DD --> EE{Action Type?}
    EE -->|list_groups| FF[List Groups]
    EE -->|list_coins| GG[List Coins]
    EE -->|claim_fees| HH[Claim Fees]
    EE -->|check_fees| II[Check Fees]
    EE -->|cancel_transaction| JJ[Cancel Transaction]
    EE -->|general_help| KK[General Help]

    E --> LL[Clear Cross-Flow Transactions]
    LL --> MM{Pending Transaction?}
    MM -->|Yes| NN[Handle Pending Transaction Update]
    MM -->|No| OO{Coin Launch Progress?}

    OO -->|Yes| PP[Continue From Progress]
    OO -->|No| QQ[Start New Coin Launch]

    QQ --> RR[Extract Coin Data]
    RR --> SS{Has All Data?}
    SS -->|Yes| TT[Launch Coin]
    SS -->|No| UU[Request Missing Data]

    style A fill:#1565C0,color:#ffffff
    style C fill:#7B1FA2,color:#ffffff
    style D fill:#F57C00,color:#ffffff
    style E fill:#2E7D32,color:#ffffff
    style G fill:#D32F2F,color:#ffffff
    style O fill:#8E24AA,color:#ffffff
    style Q fill:#D32F2F,color:#ffffff
    style R fill:#4CAF50,color:#ffffff
```

---

## 8. Direct Message Handling System

This diagram shows how the system handles direct messages (1-on-1 conversations) differently from group chats, with smart routing for status inquiries, live data fetching for groups/coins queries, and structured guidance for blocked functionality.

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
    L -->|Status| M[Detect Status Inquiry Type]
    L -->|Capability| N[Send Structured Message]
    L -->|General| N

    M --> O{Groups/Coins Query?}
    O -->|Yes| P[Fetch Live Data from Blockchain]
    O -->|No| Q[Send Structured Message]

    P --> R[SessionManager.getUserStateWithLiveData]
    R --> S[UserDataService.injectGroupData]
    S --> T[GraphQLService.fetchGroupData]
    T --> U[Display Actual Groups/Coins Data]

    U --> V[Format Groups with Live Data]
    V --> W[Show Holders, Market Cap, Fees]
    W --> X[Display Contract Addresses]

    N --> Y[Same Structured Response:<br/>Bot works in groups only]
    Q --> Y

    Z[Group Chat] --> AA[Normal Flow Processing]
    AA --> BB[Full Functionality Available]
    BB --> CC[User State Updates]
    BB --> DD[Coin Launch Capability]
    BB --> EE[Management Features]

    style A fill:#1565C0,color:#ffffff
    style F fill:#D32F2F,color:#ffffff
    style G fill:#D32F2F,color:#ffffff
    style K fill:#F57C00,color:#ffffff
    style P fill:#2E7D32,color:#ffffff
    style R fill:#388E3C,color:#ffffff
    style S fill:#388E3C,color:#ffffff
    style T fill:#388E3C,color:#ffffff
    style U fill:#4CAF50,color:#ffffff
    style V fill:#4CAF50,color:#ffffff
    style W fill:#4CAF50,color:#ffffff
    style X fill:#4CAF50,color:#ffffff
    style Z fill:#2E7D32,color:#ffffff
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

    style A fill:#1565C0,color:#ffffff
    style HH fill:#7B1FA2,color:#ffffff
    style B fill:#F57C00,color:#ffffff
    style C fill:#2E7D32,color:#ffffff
    style D fill:#4CAF50,color:#ffffff
    style E fill:#8E24AA,color:#ffffff
    style F fill:#FFA726,color:#ffffff
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

This diagram shows the overall system architecture and how all components interact with each other, including the updated flow routing priorities.

```mermaid
graph TD
    A[XMTP Message Stream] --> B[EnhancedMessageCoordinator]
    B --> C[Message Filtering & Coordination]
    C --> D[FlowRouter with Priority System]
    D --> E[Intent Classification via LLM]
    E --> F{Route to Flow with Priority}

    F -->|Priority 0: Existing Progress| G[coin_launch - Continue]
    F -->|Priority 1: High Confidence| H[qa - Status Inquiry]
    F -->|Priority 2: Actions| I[coin_launch/management - Actions]
    F -->|Priority 3+: Fallback| J[qa - Help & Questions]

    G --> K[Handle Coin Launch with Attachment Support]
    H --> L[Handle Questions & Status]
    I --> M[Manage Groups & Launch Coins]
    J --> N[Provide Help & Explanations]

    O[SessionManager] --> P[FileStateStorage]
    P --> Q[user-states.json]

    R[Services Layer] --> S[GraphQLService]
    R --> T[UserDataService]
    R --> U[ENSResolverService]
    R --> V[GroupStorageService]

    S --> W[External API]
    T --> X[Live Data Injection]
    U --> Y[ENS Resolution]
    V --> Z[Multi-User State Management]

    AA[XMTPStatusMonitor] --> BB[RSS Feed Monitoring]
    BB --> CC[Automatic Restart on Issues]
    CC --> DD[Application Factory]
    DD --> EE[Recreate All Components]

    FF[InstallationManager] --> GG[XMTP Client Creation]
    GG --> HH[Handle Installation Limits]
    HH --> II[Retry Logic & Fallbacks]

    K --> O
    L --> O
    M --> O
    N --> O

    K --> R
    L --> R
    M --> R
    N --> R

    JJ[Tools & Utilities] --> KK[Character System]
    JJ --> LL[IPFS Upload]
    JJ --> MM[Transaction Utils]
    JJ --> NN[ENS Resolution]

    K --> JJ
    M --> JJ
    N --> JJ

    OO[External Systems] --> PP[Flaunch Protocol]
    OO --> QQ[Base/Sepolia Networks]
    OO --> RR[IPFS Storage]
    OO --> SS[XMTP Network]

    style A fill:#1565C0,color:#ffffff
    style B fill:#7B1FA2,color:#ffffff
    style D fill:#F57C00,color:#ffffff
    style G fill:#4CAF50,color:#ffffff
    style O fill:#2E7D32,color:#ffffff
    style R fill:#4CAF50,color:#ffffff
    style AA fill:#8E24AA,color:#ffffff
    style FF fill:#FFA726,color:#ffffff
    style OO fill:#607D8B,color:#ffffff
```

---

## Key System Features

### Message Coordination

- **1-second wait time** to coordinate text + image messages
- **Smart queuing** system for related messages
- **Automatic retry** logic for failed coordination
- **Attachment-only message handling** with dual-layer protection

### Smart Filtering

- Only responds in group chats when **explicitly mentioned** or in **active threads**
- **LLM-powered engagement detection** for edge cases
- **Thread timeout management** (5 minutes of inactivity)

### Priority-Based Flow Routing

- **Priority 0 (HIGHEST)**: Continue existing coin launch progress
- **Priority 1**: High-confidence status inquiries
- **Priority 2**: Action intents (coin launch, modifications)
- **Priority 3+**: Questions, management, social, fallback

### Attachment-Only Message Protection

- **FlowRouter Priority Check**: Routes to coin_launch flow when existing progress exists
- **QAFlow Guard Clause**: Prevents overriding existing coin launch progress
- **Special Case Handler**: Processes attachment-only messages during data collection
- **Data Preservation**: Maintains existing name/ticker when adding image

### Direct Message Handling

- **Smart flow-based routing** for 1-on-1 conversations
- **QA Flow messages** (greetings, questions, help) are allowed but provide structured guidance
- **Groups/Coins status queries** in DMs now fetch and display real live data from GraphQL API with holders, market cap, fees, and contract addresses
- **Management and Coin Launch flows** are blocked with group requirement message
- **No user state updates** for blocked direct message interactions
- **Consistent structured responses** with clear step-by-step instructions
- **Live data integration** for status inquiries about user's groups and coins

### State Management

- **Persistent user states** stored in `user-states.json`
- **Improved live data injection** from external APIs that works for all users with coins/groups regardless of status
- **Automatic user status updates** from "new" to "active" after successful coin launch
- **Multi-user group management** with automatic state sharing
- **Automatic group creation** for all chat room members during coin launch

### Transaction Processing

- **Enhanced transaction reference handling** with proper null checks and error validation
- **Robust error handling** with detailed logging for debugging
- **Automatic manager address extraction** for first launches
- **Proper coin storage** for all group members after successful launch

### Automatic Restart

- **Monitors XMTP status** via RSS feed every 5 minutes
- **Automatic restart** on critical issues or when issues are resolved
- **Graceful cleanup** and resource management

### Multi-Flow Architecture

- **QA Flow**: Handles questions, explanations, and help requests (with DM awareness and live data for groups/coins queries) + Protection against overriding existing progress
- **Management Flow**: Manages existing groups, coins, and transactions (group chats only)
- **Coin Launch Flow**: Handles new coin creation with automatic group setup and member management (group chats only) + Special attachment-only handling

### Installation Limit Handling

- **Graceful handling** of XMTP's 5-installation limit
- **Retry logic** with exponential backoff
- **Fallback strategies** and error notifications

### Service Integration

- **External API calls** for live data with proper type handling (string to number conversions)
- **ENS resolution** for user-friendly addresses
- **Multi-user management** for group operations
- **IPFS integration** for image storage

## Debugging Guide

When debugging issues, refer to these diagrams to understand:

1. **Message not being processed**: Check diagram #4 (Message Filtering)
2. **Flow routing issues**: Check diagram #5 (Flow Router & Intent Classification)
3. **State persistence problems**: Check diagram #6 (User State Management)
4. **Restart/connection issues**: Check diagram #2 (Status Monitor)
5. **Transaction handling**: Check diagram #11 (Coin Launch Flow) and #3 (Transaction Reference Processing)
6. **Direct message handling**: Check diagram #8 (Direct Message Handling System)
7. **QA Flow responses in DMs**: Check diagram #7 (Flow Processing System) and #8 (Direct Message Handling)
8. **Attachment-only message issues**: Check diagram #12 (Attachment-Only Message Handling)

### Attachment-Only Message Debugging

- **Attachment routed to wrong flow**: Check FlowRouter priority 0 check for existing coinLaunchProgress
- **Existing progress overridden**: Check QAFlow guard clause protection layer
- **Image not processed during collection**: Check CoinLaunchFlow special case handler
- **Data loss (name/ticker cleared)**: Verify both protection layers are working and no bypass occurred
- **User state corruption**: Check if attachment processing preserves existing coinData
- **Flow routing bypassed**: Verify FlowRouter.getPrimaryFlow priority 0 logic

### Flow Router Priority Debugging

- **Priority 0 not working**: Check if groupState.coinLaunchProgress exists
- **Wrong priority triggered**: Verify LLM intent classification and confidence levels
- **Flow routing inconsistent**: Check priority order and fallback logic
- **Intent classification failing**: Verify LLM prompt and response parsing

### Coin Launch Progress Debugging

- **Progress not continuing**: Check if existing coinLaunchProgress is detected
- **Data collection step stuck**: Verify attachment-only special case handler
- **Missing data not requested**: Check requestMissingData logic
- **Transaction not created**: Verify all required data is present

### User State Management Debugging

- **Status stuck at "new"**: Check if coin launch success triggers status update to "active"
- **Groups not appearing**: Verify automatic group creation during coin launch
- **Coins missing after launch**: Check if `addCoinToAllGroupMembers` is being called
- **Live data not persisting**: Verify enriched state is being saved back to storage
- **Progress state corrupted**: Check if coinLaunchProgress is being properly updated

Each diagram provides the logical flow to trace through when investigating specific types of issues. The new attachment-only message handling system provides comprehensive protection against data loss during coin launch data collection.
