import * as OAuth2 from "simple-oauth2";
import {
  TaskEither,
  tryCatch,
  taskEither,
  fromLeft
} from "fp-ts/lib/TaskEither";
import { Option, some, none } from "fp-ts/lib/Option";
import * as fs from "fs";
import * as os from "os";
import { logInfo, logDetail, logError } from "./utils";
import express = require("express");
import fetch, { Headers } from "node-fetch";
import { constIdentity } from "fp-ts/lib/function";
import { array } from "fp-ts";
import { Interval } from "./commands/add";

const ferioAccessKey = process.env.TEAMWEEK_API_ACCESS_KEY;
const ferioSecretKey = process.env.TEAMWEEK_API_SECRET_KEY;

const ferioDir = `${os.homedir()}/.buildo/ferio`;
const credentialsPath = `${ferioDir}/teamweek_credentials`;

const port = 5556;

const oauth2 = OAuth2.create({
  client: {
    id: ferioAccessKey,
    secret: ferioSecretKey
  },
  auth: {
    tokenHost: "https://teamweek.com",
    tokenPath: "/api/v3/authenticate/token.json",
    authorizeHost: "https://teamweek.com",
    authorizePath: "/oauth/login"
  }
});

type Credentials = OAuth2.Token;

export function authenticate(): TaskEither<unknown, Credentials> {
  const p = () =>
    new Promise((resolve, reject) => {
      const retrieveCredentials = (): Option<Credentials> => {
        if (fs.existsSync(credentialsPath)) {
          const tokens = JSON.parse(
            fs.readFileSync(credentialsPath, "utf-8")
          ) as OAuth2.Token;
          if (!oauth2.accessToken.create(tokens).expired()) {
            return some(tokens);
          }
          return none;
        }
        return none;
      };

      return retrieveCredentials().foldL(() => {
        const authorizationUri = oauth2.authorizationCode.authorizeURL({
          redirect_uri: `http://localhost:${port}/authorize`,
          state: Math.random()
            .toString(36)
            .substring(20)
        });

        logInfo("\nVisit this URL to authenticate with your Teamweek account:");
        logDetail(`\n  ${authorizationUri}`);

        const app = express();

        app.get("/authorize", (req, res) => {
          const code = req.query.code;
          res
            .status(200)
            .send(
              "Successfully authenticated! You can now close this tab and go back to your terminal."
            );

          const tokenConfig = {
            code,
            redirect_uri: "http://localhost:5555/authorize"
          };

          oauth2.authorizationCode
            .getToken(tokenConfig)
            .then(result => {
              const accessToken = oauth2.accessToken.create(result);
              if (!fs.existsSync(ferioDir)) {
                fs.mkdirSync(ferioDir, { recursive: true });
              }
              fs.writeFileSync(
                credentialsPath,
                JSON.stringify(accessToken.token, null, 2)
              );
              return accessToken.token;
            })
            .then(resolve, reject);
        });
        app.listen(port);
      }, resolve);
    });

  return tryCatch(p, r => r);
}

function authenticatedRequest<A, B = {}>(
  path: string,
  method: "GET" | "POST",
  body?: B
): TaskEither<unknown, A> {
  return authenticate()
    .chain(token =>
      tryCatch(
        () =>
          fetch(`https://teamweek.com/api/v4${path}`, {
            method,
            headers: new Headers({
              Authorization: `Bearer ${token["access_token"]}`
            }),
            body: JSON.stringify(body)
          }).then(r => r.json()),
        constIdentity
      )
    )
    .mapLeft(logError);
}

function get<A>(path: string): TaskEither<unknown, A> {
  return authenticatedRequest(path, "GET");
}

function post<A, B>(path: string, body: B): TaskEither<unknown, A> {
  return authenticatedRequest(path, "POST", body).map<A>((x: any) => {
    return x;
  });
}

interface Workspace {
  id: number;
  name: string;
}

interface User {
  id: number;
  name: string;
  email: string;
  workspaces: Array<Workspace>;
}

interface Task {
  name: string;
  start_date: string;
  end_date: string;
  user_id: number;
  project_id: number;
  color: string;
  estimated_hours: number;
  pinned: boolean;
  done: boolean;
}

interface Project {
  id: number;
  name: string;
  archived: boolean;
  color: string;
}

export function getMe(): TaskEither<unknown, User> {
  return get("/me");
}

export function getBuildoWorkspace(): TaskEither<unknown, Workspace> {
  return getMe().chain(user =>
    array
      .findFirst(user.workspaces, w => w.name.toLowerCase() === "buildo")
      .fold(fromLeft("'buildo' workspace not found"), taskEither.of)
  );
}

export function getProjects(): TaskEither<unknown, Array<Project>> {
  return getBuildoWorkspace().chain(workspace =>
    get(`/${workspace.id}/projects`)
  );
}

export function getFerieProject(): TaskEither<unknown, Project> {
  return getProjects().chain(projects =>
    array
      .findFirst(projects, w => w.name.toLowerCase() === "ferie")
      .fold(fromLeft("'ferie' project not found"), taskEither.of)
  );
}

export function addTask(
  name: string,
  interval: Interval
): TaskEither<unknown, void> {
  return getMe().chain(user =>
    getBuildoWorkspace().chain(workspace =>
      getFerieProject().chain(project =>
        post<void, Task>(`/${workspace.id}/tasks`, {
          name,
          project_id: project.id,
          user_id: user.id,
          start_date: interval.from.toISOString().split("T")[0],
          end_date: interval.to.toISOString().split("T")[0],
          color: project.color,
          done: false,
          pinned: false,
          estimated_hours: 0
        })
      )
    )
  );
}
