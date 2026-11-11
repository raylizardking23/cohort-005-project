import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { asc, desc, eq, ne } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { db } from "~/db";
import {
  courses,
  purchases,
  refunds,
  users,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  getCompletedLessonCount,
  getLessonIdsForCourse,
  getSecondsWatched,
  REFUND_COMPLETION_LIMIT,
  REFUND_WATCH_LIMIT_SECONDS,
  REFUND_WINDOW_DAYS,
} from "~/lib/refund-eligibility.server";
import { resolveRefundRequest } from "~/lib/refund-resolution.server";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

const viewSchema = z.enum(["open", "history"]).catch("open");

const resolutionActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundId: z.coerce.number().int(),
    declineNote: z
      .string()
      .trim()
      .min(1, "Write a Decline Note so the learner knows why.")
      .max(1000, "Please keep the Decline Note under 1000 characters."),
  }),
]);

const RESOLUTION_ERRORS = {
  "not-found": { message: "Refund request not found.", status: 404 },
  "already-resolved": {
    message: "This refund request has already been resolved.",
    status: 409,
  },
  "decline-note-required": {
    message: "Write a Decline Note so the learner knows why.",
    status: 400,
  },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function requireAdmin(userId: number | null, message: string) {
  if (!userId) {
    throw data("Select a user from the DevUI panel to manage refunds.", {
      status: 401,
    });
  }

  const user = db.select().from(users).where(eq(users.id, userId)).get();

  if (!user || user.role !== UserRole.Admin) {
    throw data(message, { status: 403 });
  }

  return user;
}

function getRefundRequests(view: "open" | "history") {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      declineNote: refunds.declineNote,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      refundAmount: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .where(
      view === "open"
        ? eq(refunds.status, RefundStatus.Open)
        : ne(refunds.status, RefundStatus.Open)
    )
    .orderBy(
      view === "open" ? asc(refunds.requestedAt) : desc(refunds.resolvedAt)
    )
    .all();
}

/** The learner's Progress now, measured against the Refund Eligibility limits. */
function getProgress(learnerId: number, courseId: number, purchasedAt: string) {
  const lessonIds = getLessonIdsForCourse(courseId);

  return {
    completedLessons: getCompletedLessonCount(learnerId, lessonIds),
    totalLessons: lessonIds.length,
    secondsWatched: getSecondsWatched(learnerId, lessonIds),
    daysSincePurchase: Math.floor(
      (Date.now() - Date.parse(purchasedAt)) / DAY_MS
    ),
  };
}

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Resolve learners' refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireAdmin(
    await getCurrentUserId(request),
    "Only admins can access this page."
  );

  const view = viewSchema.parse(new URL(request.url).searchParams.get("view"));

  const refundRequests = getRefundRequests(view).map((row) => ({
    ...row,
    progress: getProgress(row.learnerId, row.courseId, row.purchasedAt),
  }));

  return {
    view,
    refundRequests,
    limits: {
      windowDays: REFUND_WINDOW_DAYS,
      watchSeconds: REFUND_WATCH_LIMIT_SECONDS,
      completionShare: REFUND_COMPLETION_LIMIT,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = requireAdmin(
    await getCurrentUserId(request),
    "Only admins can resolve refund requests."
  );

  const formData = await request.formData();
  const parsed = parseFormData(formData, resolutionActionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const result = resolveRefundRequest(
    input.refundId,
    admin.id,
    input.intent === "approve"
      ? { decision: "approve" }
      : { decision: "decline", declineNote: input.declineNote }
  );

  if (!result.ok) {
    const { message, status } = RESOLUTION_ERRORS[result.reason];
    throw data(message, { status });
  }

  const { email } = result;
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { success: true, intent: input.intent };
}

function formatWatched(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const STATUS_STYLES: Record<RefundStatus, string> = {
  [RefundStatus.Open]:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  [RefundStatus.Approved]:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  [RefundStatus.Declined]: "bg-muted text-muted-foreground",
};

const STATUS_LABELS: Record<RefundStatus, string> = {
  [RefundStatus.Open]: "Open",
  [RefundStatus.Approved]: "Approved",
  [RefundStatus.Declined]: "Declined",
};

type RefundRequestRow = Awaited<
  ReturnType<typeof loader>
>["refundRequests"][number];
type Limits = Awaited<ReturnType<typeof loader>>["limits"];

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { view, refundRequests, limits } = loaderData;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline learners&apos; refund requests. Approving ends
          the learner&apos;s access to the course.
        </p>
      </div>

      <div className="mb-6 flex gap-2">
        <Link to="/admin/refunds">
          <Button variant={view === "open" ? "default" : "outline"} size="sm">
            Open
          </Button>
        </Link>
        <Link to="/admin/refunds?view=history">
          <Button
            variant={view === "history" ? "default" : "outline"}
            size="sm"
          >
            History
          </Button>
        </Link>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {view === "open"
              ? "No open refund requests."
              : "No refund requests have been resolved yet."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
              limits={limits}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RefundRequestCard({
  refundRequest,
  limits,
}: {
  refundRequest: RefundRequestRow;
  limits: Limits;
}) {
  const { progress } = refundRequest;
  const completionLimit = Math.ceil(
    progress.totalLessons * limits.completionShare
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${refundRequest.courseSlug}`}
              className="text-lg font-semibold hover:underline"
            >
              {refundRequest.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {refundRequest.learnerName} · {refundRequest.learnerEmail}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">
              {formatPrice(refundRequest.refundAmount)}
            </p>
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[refundRequest.status]}`}
            >
              {STATUS_LABELS[refundRequest.status]}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">
            Reason · requested{" "}
            {new Date(refundRequest.requestedAt).toLocaleDateString()}
          </p>
          <p className="mt-1 text-sm">{refundRequest.reason}</p>
        </div>

        <dl className="grid grid-cols-1 gap-3 rounded-md border p-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Lessons completed</dt>
            <dd className="font-medium">
              {progress.completedLessons} of {progress.totalLessons}
              <span className="text-muted-foreground">
                {" "}
                (limit {completionLimit})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Time watched</dt>
            <dd className="font-medium">
              {formatWatched(progress.secondsWatched)}
              <span className="text-muted-foreground">
                {" "}
                (limit {formatWatched(limits.watchSeconds)})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Since purchase</dt>
            <dd className="font-medium">
              {progress.daysSincePurchase} days
              <span className="text-muted-foreground">
                {" "}
                (window {limits.windowDays})
              </span>
            </dd>
          </div>
        </dl>

        {refundRequest.status === RefundStatus.Open ? (
          <ResolutionForm refundId={refundRequest.id} />
        ) : (
          <div className="text-sm text-muted-foreground">
            {STATUS_LABELS[refundRequest.status]}
            {refundRequest.resolvedAt &&
              ` on ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`}
            {refundRequest.declineNote && (
              <p className="mt-1 text-foreground">
                Decline Note: {refundRequest.declineNote}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResolutionForm({ refundId }: { refundId: number }) {
  const fetcher = useFetcher<{
    success?: boolean;
    intent?: string;
    error?: string;
  }>();
  const [isDeclining, setIsDeclining] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.error) toast.error(fetcher.data.error);
    if (fetcher.data.success) {
      toast.success(
        fetcher.data.intent === "approve"
          ? "Refund request approved."
          : "Refund request declined."
      );
    }
  }, [fetcher.state, fetcher.data]);

  if (isDeclining) {
    return (
      <fetcher.Form method="post" className="space-y-2">
        <input type="hidden" name="intent" value="decline" />
        <input type="hidden" name="refundId" value={refundId} />
        <Textarea
          name="declineNote"
          rows={3}
          required
          placeholder="Explain to the learner why their refund request is declined."
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Declining..." : "Decline"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setIsDeclining(false)}
          >
            Back
          </Button>
        </div>
      </fetcher.Form>
    );
  }

  return (
    <div className="flex gap-2">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="approve" />
        <input type="hidden" name="refundId" value={refundId} />
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Approving..." : "Approve"}
        </Button>
      </fetcher.Form>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isSubmitting}
        onClick={() => setIsDeclining(true)}
      >
        Decline
      </Button>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
