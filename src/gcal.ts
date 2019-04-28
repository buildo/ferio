import * as express from "express";
import * as fs from "fs";
import * as os from "os";
import { google, oauth2_v2, calendar_v3 } from "googleapis";
import { logInfo, logDetail, logError } from "./utils";
import { TaskEither, tryCatch } from "fp-ts/lib/TaskEither";
import { Credentials } from "google-auth-library";
import { Interval } from "./commands/add";
import { format, addDays, startOfDay, endOfDay } from "date-fns";
import { GaxiosResponse } from "gaxios";
import { constIdentity } from "fp-ts/lib/function";
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

function authenticate(): TaskEither<unknown, Credentials> {
  const p = () =>
    new Promise<Credentials>((resolve, reject) => {
      const retrieveCredentials = () => {
        if (fs.existsSync(credentialsPath)) {
          const tokens = JSON.parse(
            fs.readFileSync(credentialsPath, "utf-8")
          ) as Credentials;
          if (tokens.expiry_date > Date.now()) {
            oauth2Client.setCredentials(tokens);
            return tokens;
          }
        }
        return null;
      };

      const credentials = retrieveCredentials();
      if (credentials) {
        resolve(credentials);
        return;
      }

      const scopes = [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.profile"
      ];

      const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: scopes
      });

      logInfo("\nVisit this URL to authenticate with your Google account:");
      logDetail(`\n  ${url}`);

      const app = express();

      app.get("/authorize", (req, res) => {
        const code = req.query.code;
        res
          .status(200)
          .send(
            "Successfully authenticated! You can now close this tab and go back to your terminal."
          );

        oauth2Client.getToken(code, (err, tokens) => {
          if (!err) {
            if (!fs.existsSync(ferioDir)) {
              fs.mkdirSync(ferioDir, { recursive: true });
            }
            fs.writeFileSync(credentialsPath, JSON.stringify(tokens, null, 2));
            oauth2Client.setCredentials(tokens);
            logInfo(
              "\n:white_check_mark: Successfully authenticated. Let's move on!"
            );
            resolve(tokens);
          } else {
            logError(`${err.response.status} ${err.response.statusText}`);
            logError(JSON.stringify(err.response.data));
            reject(err);
          }
        });
      });

      app.listen(port);
    });

  return tryCatch(p, r => r);
}

function authenticatedApiCall<A>(
  f: () => Promise<GaxiosResponse<A>>
): TaskEither<unknown, A> {
  return authenticate()
    .chain(() => tryCatch(f, constIdentity))
    .map(r => r.data);
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
