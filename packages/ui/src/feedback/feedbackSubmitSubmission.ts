import {
  DEFAULT_FEEDBACK_TICKET_FRAMEWORK,
  type FeedbackTicketModule,
  type FeedbackTicketSeverity,
  type FeedbackTicketType,
  type Locale,
} from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { persistFeedbackContactPreference } from "@/feedback/feedbackContactPreference.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import type { ScreenshotAttachmentDraft } from "@/feedback/FeedbackScreenshotPicker.js";
import {
  buildDeveloperFacingDescription,
  buildFeedbackTitle,
} from "@/feedback/feedbackSubmitDescription.js";
import type { FeedbackAgentModelContext } from "@/feedback/feedbackSubmitModelContext.js";
import {
  startFeedbackSubmissionJob,
  type FeedbackSubmissionCopy,
  type FeedbackSubmissionJob,
} from "@/feedback/feedbackSubmissionJob.js";

const FEEDBACK_ZCODE_AGENT_LABEL = "ZCode Agent";

export const DEFAULT_FEEDBACK_TYPE: FeedbackTicketType = "bug";
export const DEFAULT_FEEDBACK_SEVERITY: FeedbackTicketSeverity = "P2-中";
export const DEFAULT_FEEDBACK_MODULE: FeedbackTicketModule = "其它";

export async function startSimplifiedFeedbackSubmission({
  feedbackService,
  title,
  description,
  contact,
  screenshots,
  includeLogs,
  ticketType,
  ticketSeverity,
  ticketModule,
  modelContext,
  locale,
  copy,
  formatMessage,
  onTicketCreated,
  onCompleted,
  onError,
}: {
  feedbackService: IFeedbackService;
  title?: string;
  description: string;
  contact: string;
  screenshots: ScreenshotAttachmentDraft[];
  includeLogs: boolean;
  ticketType: FeedbackTicketType;
  ticketSeverity: FeedbackTicketSeverity;
  ticketModule: FeedbackTicketModule;
  modelContext: FeedbackAgentModelContext;
  locale: Locale;
  copy: FeedbackSubmissionCopy;
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
  onTicketCreated?: (ticketId: string) => void;
  onCompleted: (ticketId: string) => void;
  onError: (message: string) => void;
}): Promise<FeedbackSubmissionJob> {
  const device = await feedbackService.getDeviceSnapshot();
  const framework = DEFAULT_FEEDBACK_TICKET_FRAMEWORK;
  const normalizedDescription = description.trim();
  const trimmedContact = contact.trim();
  persistFeedbackContactPreference(trimmedContact);
  const attachmentDrafts = screenshots.map(({ id: _id, ...screenshot }) => ({ ...screenshot }));
  const formDraft: FeedbackSubmitDraft = {
    ...(title !== undefined ? { title } : {}),
    description,
    contact,
    screenshots: attachmentDrafts,
    includeLogs,
    type: ticketType,
    severity: ticketSeverity,
    module: ticketModule,
  };
  return startFeedbackSubmissionJob({
    feedbackService,
    ticketInput: {
      title: buildFeedbackTitle(title ?? normalizedDescription, formatMessage),
      description: buildDeveloperFacingDescription({
        raw: normalizedDescription,
        modelContext,
        ticketType,
        ticketModule,
        ticketSeverity,
        formatMessage,
      }),
      type: ticketType,
      severity: ticketSeverity,
      module: ticketModule,
      framework,
      device: {
        ...device,
        agentProvider: FEEDBACK_ZCODE_AGENT_LABEL,
        agentFramework: framework,
        ...(modelContext.model ? { agentModel: modelContext.model } : {}),
        ...(modelContext.display ? { agentModelDisplay: modelContext.display } : {}),
      },
      source: "desktop-app",
      contact: trimmedContact || undefined,
      locale,
    },
    screenshots: attachmentDrafts,
    includeLogs,
    formDraft,
    copy,
    onTicketCreated,
    onCompleted,
    onError,
  });
}
