import { logInfo, logDetail, logError } from "../utils";
import {
  prompt,
  Questions,
  Answers,
  registerPrompt,
  ChoiceType
} from "inquirer";
import {
  ReaderTaskEither,
  ask,
  fromTaskEither
} from "fp-ts/lib/ReaderTaskEither";
import { TaskEither, tryCatch, taskEither } from "fp-ts/lib/TaskEither";
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
  return askWhere()
    .chain(where =>
      askWhen().chain(when => {
        logInfo(
          `:ok_hand: ${where} from ${format(when.from, "DD/MM/YY")} to ${format(
            when.to,
            "DD/MM/YY"
          )}, got it!`
        );
        return (
          addOnCalendar()
            .chain(addOnTeamweek)
            // .chain(addOnSlack)
            .value({ when, where })
        );
      })
    )
    .mapLeft(logError)
    .run()
    .catch(logError);
}

export interface Interval {
  from: Date;
  to: Date;
}

function askPrompt(questions: Questions): TaskEither<unknown, Answers> {
  return tryCatch(() => prompt(questions), reason => reason);
}

function askWhere(): TaskEither<unknown, string> {
  return askPrompt([
    {
      type: "input",
      name: "where",
      message: "Where are you going?"
    }
  ]).map(a => a.where);
}

function askWhen(): TaskEither<unknown, Interval> {
  const from = askPrompt([
    {
      type: "datetime",
      name: "when_from",
      message: "From when?",
      date: {
        min: format(Date.now(), "M/D/YYYY")
      },
      format: ["dd", "/", "mm", "/", "yyyy"]
    } as any
  ]).map(a => a.when_from);

  return from.chain(fromDate =>
    askPrompt([
      {
        type: "datetime",
        name: "when_to",
        message: "To when?",
        initial: fromDate,
        format: ["dd", "/", "mm", "/", "yyyy"]
      } as any
    ])
      .map(a => a.when_to)
      .map(toDate => ({
        from: fromDate,
        to: toDate
      }))
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
    return askPrompt([
      {
        type: "checkbox",
        name: "eventsToDecline",
        message: "Choose the ones you want to decline:",
        choices: eventsToChoices(eventsInvited, true)
      }
    ]).chain(
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
    return askPrompt([
      {
        type: "checkbox",
        name: "eventsToDelete",
        message: "Choose the ones you want to delete:",
        choices: eventsToChoices(nonRecurrentEvensts, false)
      }
    ]).chain(
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
  return ask<Context, unknown>().chain(({ when }) =>
    fromTaskEither(
      getEvents(when).chain(response => {
        const eventsInvited = response.items.filter(event => event.attendees);
        const eventsCreated = response.items.filter(
          event => event.creator.self
        );
        return manageEventsCreated(eventsCreated).chainSecond(
          manageEventsInvited(eventsInvited)
        );
      })
    )
  );
}

function createEventOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  return ask<Context, unknown>().chain(({ when, where }) =>
    fromTaskEither(
      createEvent(when, `Ferie ${where}`).map(events => {
        logInfo(
          "\n:white_check_mark: Created event on your calendar. Click here to see it:\n"
        );
        logDetail(events.htmlLink);
        logDetail("\n");
      })
    )
  );
}

type Context = {
  when: Interval;
  where: string;
};

function addOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  logInfo("\n:calendar: Adding your vacation to Google Calendar...\n");
  return manageExistingEvents().chain(createEventOnCalendar);
}

function addOnTeamweek(): ReaderTaskEither<Context, unknown, void> {
  logInfo("\n:hourglass: Adding your vacation to Teamweek...\n");
  return ask<Context, unknown>().chain(({ when, where }) =>
    fromTaskEither(addTask(where, when))
  );
}

declare function addOnSlack(): ReaderTaskEither<Context, unknown, void>;
