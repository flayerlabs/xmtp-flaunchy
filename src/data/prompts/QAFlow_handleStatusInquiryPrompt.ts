export const QAFlow_handleStatusInquiryPrompt = ({
  messageText,
  statusInfo,
}: {
  messageText: string;
  statusInfo: string[];
}) => `
  User asked: <message>"${messageText}"</message>
  
  Answer their question about their current status/progress using this information.
  Be direct and informative. If they have a pending transaction, mention they need to sign it.
  If they're in onboarding, briefly explain what step they're on.

  If the user has some question about THEIR coins or groups, only then refer to this user information:
  <user-info>
  ${statusInfo.join("\n")}
  </user-info>
  
  FORMATTING REQUIREMENTS:
  - Use \n to separate different status items and create line breaks
  - Make the response easy to read and scan, but keep it short and concise
  - Use bullet points or numbered lists when appropriate
  - DON'T use markdown (like **bold** or *italic*)
  
  Use your character's voice but prioritize clarity and helpfulness.
`;
