import { logInfo, logDetail, logError } from "../utils";
import {
  prompt,
  Questions,
  Answers,
  registerPrompt,
  ChoiceType
} from "inquirer";
import { ReaderTaskEither, readerTaskEither } from "fp-ts/lib/ReaderTaskEither";
import {
  TaskEither,
  tryCatch,
  taskEither,
  mapLeft
} from "fp-ts/lib/TaskEither";
import * as yargs from "yargs";
import { createEvent, getEvents, declineEvent, deleteEvent } from "../gcal";
import { array } from "fp-ts/lib/Array";
import { calendar_v3 } from "googleapis";
import { format } from "date-fns";
import { addTask } from "../teamweek";
import chalk from "chalk";

registerPrompt("datetime", require("inquirer-datepicker-prompt"));

export const command = "add";
export const desc = "Add a new vacation";
export const builder: { [key: string]: yargs.Options } = {};

export function handler(): Promise<unknown> {
  logInfo(":palm_tree: Getting a break? Great!\n");
  return mapLeft(
    taskEither.chain(askWhere(), where =>
      taskEither.chain(askWhen(), when => {
        logInfo(
          `:ok_hand: ${where} from ${format(when.from, "DD/MM/YY")} to ${format(
            when.to,
            "DD/MM/YY"
          )}, got it!`
        );
        return readerTaskEither.chain(addOnCalendar(), addOnTeamweek)({
          when,
          where
        });
        // .chain(addOnSlack)
      })
    ),
    logError
  )().catch(logError);
}

export interface Interval {
  from: Date;
  to: Date;
}

function askPrompt(questions: Questions): TaskEither<unknown, Answers> {
  return tryCatch(() => prompt(questions), reason => reason);
}

function askWhere(): TaskEither<unknown, string> {
  return taskEither.map(
    askPrompt([
      {
        type: "input",
        name: "where",
        message: "Where are you going?"
      }
    ]),
    a => a.where
  );
}

function askWhen(): TaskEither<unknown, Interval> {
  const from = taskEither.map(
    askPrompt([
      {
        type: "datetime",
        name: "when_from",
        message: "From when?",
        date: {
          min: format(Date.now(), "M/D/YYYY")
        },
        format: ["dd", "/", "mm", "/", "yyyy"]
      } as any
    ]),
    a => a.when_from
  );

  return taskEither.chain(from, fromDate =>
    taskEither.map(
      taskEither.map(
        askPrompt([
          {
            type: "datetime",
            name: "when_to",
            message: "To when?",
            initial: fromDate,
            format: ["dd", "/", "mm", "/", "yyyy"]
          } as any
        ]),
        a => a.when_to
      ),
      toDate => ({
        from: fromDate,
        to: toDate
      })
    )
  );
}

function eventsToChoices(
  events: Array<calendar_v3.Schema$Event>,
  checked: boolean
): Array<ChoiceType> {
  return events.map(event => ({
    name: `${format(
      event.start.dateTime || event.start.date,
      "ddd DD MMM"
    )} - ${event.summary}`,
    value: event,
    checked
  }));
}

function manageEventsInvited(
  eventsInvited: Array<calendar_v3.Schema$Event>
): TaskEither<unknown, unknown> {
  if (eventsInvited.length === 0) {
    return taskEither.of(null);
  } else {
    console.log(
      `  These are the events you're ${chalk.yellow.bold(
        "invited to"
      )} during your vacation.`
    );
    return taskEither.chain(
      askPrompt([
        {
          type: "checkbox",
          name: "eventsToDecline",
          message: "Choose the ones you want to decline:",
          choices: eventsToChoices(eventsInvited, true)
        }
      ]),
      ({
        eventsToDecline
      }: {
        eventsToDecline: Array<calendar_v3.Schema$Event>;
      }) => array.sequence(taskEither)(eventsToDecline.map(declineEvent))
    );
  }
}

function manageEventsCreated(
  eventsCreated: Array<calendar_v3.Schema$Event>
): TaskEither<unknown, unknown> {
  const nonRecurrentEvensts = eventsCreated.filter(event => !event.recurrence);
  if (nonRecurrentEvensts.length === 0) {
    return taskEither.of(null);
  } else {
    logInfo(
      "These are the events created by you that are scheduled during your vacation."
    );
    return taskEither.chain(
      askPrompt([
        {
          type: "checkbox",
          name: "eventsToDelete",
          message: "Choose the ones you want to delete:",
          choices: eventsToChoices(nonRecurrentEvensts, false)
        }
      ]),
      ({
        eventsToDelete
      }: {
        eventsToDelete: Array<calendar_v3.Schema$Event>;
      }) => array.sequence(taskEither)(eventsToDelete.map(deleteEvent))
    );
  }
}

function manageExistingEvents(): ReaderTaskEither<Context, unknown, unknown> {
  logInfo(":sparkles: Before we move forward, let's clear up your calendar");
  return ({ when }) =>
    taskEither.chain(getEvents(when), response => {
      const eventsInvited = response.items.filter(event => event.attendees);
      const eventsCreated = response.items.filter(event => event.creator.self);
      return taskEither.chain(manageEventsCreated(eventsCreated), () =>
        manageEventsInvited(eventsInvited)
      );
    });
}

function createEventOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  return ({ when, where }) =>
    taskEither.map(createEvent(when, `Ferie ${where}`), events => {
      logInfo(
        "\n:white_check_mark: Created event on your calendar. Click here to see it:\n"
      );
      logDetail(events.htmlLink);
      logDetail("\n");
    });
}

type Context = {
  when: Interval;
  where: string;
};

function addOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  logInfo("\n:calendar: Adding your vacation to Google Calendar...\n");
  return readerTaskEither.chain(manageExistingEvents(), createEventOnCalendar);
}

function addOnTeamweek(): ReaderTaskEither<Context, unknown, void> {
  logInfo("\n:hourglass: Adding your vacation to Teamweek...\n");
  return ({ when, where }) => addTask(where, when);
}

declare function addOnSlack(): ReaderTaskEither<Context, unknown, void>;
