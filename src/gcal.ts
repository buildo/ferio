import * as express from "express";
import * as fs from "fs";
import * as os from "os";
import { google, oauth2_v2, calendar_v3 } from "googleapis";
import { logInfo, logDetail, logError } from "./utils";
import { TaskEither, tryCatch, taskify } from "fp-ts/lib/TaskEither";
import {
  Credentials,
  OAuth2Client,
  GetTokenOptions
} from "google-auth-library";
import { Interval } from "./commands/add";
import { format, addDays, startOfDay, endOfDay } from "date-fns";
import { GaxiosResponse } from "gaxios";
import { identity } from "fp-ts/lib/function";
import { taskEither } from "fp-ts/lib/TaskEither";
import { fluent } from "./utils/fluent";
import { Option, fromNullable, none, fold } from "fp-ts/lib/Option";
const OAuth2 = google.auth.OAuth2;

const port = 5555;
const host = "localhost";

const ferioDir = `${os.homedir()}/.buildo/ferio`;
const credentialsPath = `${ferioDir}/google_credentials`;

const ferioAccessKey = process.env.GOOGLE_API_ACCESS_KEY;
const ferioSecretKey = process.env.GOOGLE_API_SECRET_KEY;

const oauth2Client = new OAuth2(
  ferioAccessKey,
  ferioSecretKey,
  `http://${host}:${port}/authorize`
);

const auth = google.oauth2({
  version: "v2",
  auth: oauth2Client
});

const calendar = google.calendar({
  version: "v3",
  auth: oauth2Client
});

function retrieveExistingCredentials(): TaskEither<
  unknown,
  Option<Credentials>
> {
  return taskEither.fromIO(() => {
    if (fs.existsSync(credentialsPath)) {
      const tokens = JSON.parse(
        fs.readFileSync(credentialsPath, "utf-8")
      ) as Credentials;
      if (tokens.expiry_date > Date.now()) {
        oauth2Client.setCredentials(tokens);
        return fromNullable(tokens);
      }
    }
    return none;
  });
}

function exchangeCodeForCredentials(
  code: GetTokenOptions
): TaskEither<unknown, Credentials> {
  return fluent(taskEither)(taskify(oauth2Client.getToken)(code))
    .chain(
      credentials => saveCredentials(credentials, oauth2Client) as any // TODO
    )
    .mapLeft(err =>
      fluent(taskEither)(
        logError(`${err.response.status} ${err.response.statusText}`)
      )
        .chain(() => logError(JSON.stringify(err.response.data)))
        .value()
    ).value;
}

function authenticateWithGoogle(): TaskEither<unknown, Credentials> {
  const scopes = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.profile"
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes
  });

  return fluent(taskEither)(
    logInfo("\nVisit this URL to authenticate with your Google account:")
  )
    .chain(() => logDetail(`\n  ${url}`))
    .chain(() =>
      tryCatch(
        () =>
          new Promise<Credentials>((resolve, reject) => {
            const app = express();

            app.get("/authorize", (req, res) => {
              const code = req.query.code;

              res
                .status(200)
                .send(
                  "Successfully authenticated! You can now close this tab and go back to your terminal."
                );

              exchangeCodeForCredentials(code)().then(reject, resolve);
            });
            app.listen(port);
          }),
        identity
      )
    ).value;
}

function saveCredentials(
  tokens: Credentials,
  oauth2Client: OAuth2Client
): TaskEither<unknown, void> {
  return taskEither.fromIO(() => {
    if (!fs.existsSync(ferioDir)) {
      fs.mkdirSync(ferioDir, { recursive: true });
    }
    fs.writeFileSync(credentialsPath, JSON.stringify(tokens, null, 2));
    oauth2Client.setCredentials(tokens);
  });
}

function authenticate(): TaskEither<unknown, Credentials> {
  return fluent(taskEither)(retrieveExistingCredentials()).chain(creds =>
    fold(creds, authenticateWithGoogle, taskEither.of)
  ).value;
}

function authenticatedApiCall<A>(
  f: () => Promise<GaxiosResponse<A>>
): TaskEither<unknown, A> {
  return fluent(taskEither)(authenticate())
    .chain(() => tryCatch(f, identity))
    .map(r => r.data).value;
}

export function getMe(): TaskEither<unknown, oauth2_v2.Schema$Userinfoplus> {
  return authenticatedApiCall(() => auth.userinfo.get());
}

export function getEvents(
  interval: Interval
): TaskEither<unknown, calendar_v3.Schema$Events> {
  return authenticatedApiCall(() =>
    calendar.events.list({
      calendarId: "primary",
      timeMin: format(startOfDay(interval.from)),
      timeMax: format(endOfDay(interval.to)),
      showDeleted: false,
      singleEvents: true,
      orderBy: "startTime"
    })
  );
}

export function createEvent(
  interval: Interval,
  title: string
): TaskEither<unknown, calendar_v3.Schema$Event> {
  return authenticatedApiCall(() =>
    calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        start: {
          date: format(interval.from, "YYYY-MM-DD")
        },
        end: {
          date: format(addDays(interval.to, 1), "YYYY-MM-DD")
        }
      }
    })
  );
}

export function declineEvent(
  event: calendar_v3.Schema$Event
): TaskEither<unknown, calendar_v3.Schema$Event> {
  return authenticatedApiCall(() =>
    calendar.events.patch({
      eventId: event.id,
      calendarId: "primary",
      requestBody: {
        attendees: [
          ...(event.attendees || []).filter(a => !a.self),
          ...(event.attendees || [])
            .filter(a => a.self)
            .map(r => ({
              ...r,
              responseStatus: "declined"
            }))
        ]
      }
    })
  );
}

export function deleteEvent(
  event: calendar_v3.Schema$Event
): TaskEither<unknown, void> {
  return authenticatedApiCall(() =>
    calendar.events.delete({
      eventId: event.id,
      calendarId: "primary"
    })
  );
}
