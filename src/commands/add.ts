import { logInfo, logDetail, logError, log } from "../utils";
import {
  prompt,
  Questions,
  Answers,
  registerPrompt,
  ChoiceType
} from "inquirer";
import {
  ReaderTaskEither,
  readerTaskEither,
  readerTaskEitherSeq
} from "fp-ts/lib/ReaderTaskEither";
import {
  TaskEither,
  tryCatch,
  taskEither,
  taskEitherSeq
} from "fp-ts/lib/TaskEither";
import * as yargs from "yargs";
import { createEvent, getEvents, declineEvent, deleteEvent } from "../gcal";
import { array } from "fp-ts/lib/Array";
import { calendar_v3 } from "googleapis";
import { format } from "date-fns";
import { addTask } from "../teamweek";
import chalk from "chalk";
import { fluent } from "../utils/fluent";
import { sequenceT } from "fp-ts/lib/Apply";
import { constVoid } from "fp-ts/lib/function";

registerPrompt("datetime", require("inquirer-datepicker-prompt"));

export const command = "add";
export const desc = "Add a new vacation";
export const builder: { [key: string]: yargs.Options } = {};

export function handler(): Promise<unknown> {
  logInfo(":palm_tree: Getting a break? Great!\n");

  const askWhenWhere = sequenceT(taskEitherSeq)(askWhere(), askWhen());

  return fluent(taskEither)(askWhenWhere)
    .chain(([where, when]) => {
      logInfo(
        `:ok_hand: ${where} from ${format(when.from, "DD/MM/YY")} to ${format(
          when.to,
          "DD/MM/YY"
        )}, got it!`
      );
      return sequenceT(readerTaskEitherSeq)(addOnCalendar(), addOnTeamweek())({
        when,
        where
      });
    })
    .mapLeft(logError)
    .value()
    .catch(logError);
}

export interface Interval {
  from: Date;
  to: Date;
}

function askPrompt<A extends Answers>(
  questions: Questions
): TaskEither<unknown, A> {
  return tryCatch(() => prompt(questions) as Promise<A>, reason => reason);
}

function askWhere(): TaskEither<unknown, string> {
  const answers = askPrompt<{ where: string }>([
    {
      type: "input",
      name: "where",
      message: "Where are you going?"
    }
  ]);
  return taskEither.map(answers, a => a.where);
}

function askWhen(): TaskEither<unknown, Interval> {
  const askFrom = askPrompt<{ fromDate: Date }>([
    {
      type: "datetime",
      name: "fromDate",
      message: "From when?",
      date: {
        min: format(Date.now(), "M/D/YYYY")
      },
      format: ["dd", "/", "mm", "/", "yyyy"]
    } as any
  ]);

  return fluent(taskEither)(askFrom).chain(
    ({ fromDate }) =>
      fluent(taskEither)(
        askPrompt<{ toDate: Date }>([
          {
            type: "datetime",
            name: "toDate",
            message: "To when?",
            initial: fromDate,
            format: ["dd", "/", "mm", "/", "yyyy"]
          } as any
        ])
      ).map(({ toDate }) => ({ from: fromDate, to: toDate })).value
  ).value;
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
): TaskEither<unknown, void> {
  if (eventsInvited.length === 0) {
    return taskEither.of(null);
  } else {
    const askEventsToDecline = askPrompt<{
      eventsToDecline: Array<calendar_v3.Schema$Event>;
    }>([
      {
        type: "checkbox",
        name: "eventsToDecline",
        message: "Choose the ones you want to decline:",
        choices: eventsToChoices(eventsInvited, true)
      }
    ]);

    return fluent(taskEither)(
      log(
        `  These are the events you're ${chalk.yellow.bold(
          "invited to"
        )} during your vacation.`
      )
    )
      .chain(() => askEventsToDecline)
      .chain(({ eventsToDecline }) =>
        array.traverse(taskEither)(eventsToDecline, declineEvent)
      )
      .map(constVoid).value;
  }
}

function manageEventsCreated(
  eventsCreated: Array<calendar_v3.Schema$Event>
): TaskEither<unknown, void> {
  const nonRecurrentEvents = eventsCreated.filter(event => !event.recurrence);
  if (nonRecurrentEvents.length === 0) {
    return taskEither.of(null);
  } else {
    const askEventsToDelete = askPrompt<{
      eventsToDelete: Array<calendar_v3.Schema$Event>;
    }>([
      {
        type: "checkbox",
        name: "eventsToDelete",
        message: "Choose the ones you want to delete:",
        choices: eventsToChoices(nonRecurrentEvents, false)
      }
    ]);

    return fluent(taskEither)(
      logInfo(
        "These are the events created by you that are scheduled during your vacation."
      )
    )
      .chain(() => askEventsToDelete)
      .chain(({ eventsToDelete }) =>
        array.traverse(taskEither)(eventsToDelete, deleteEvent)
      )
      .map(constVoid).value;
  }
}

function manageExistingEvents(): ReaderTaskEither<Context, unknown, void> {
  return ({ when }) =>
    fluent(taskEither)(
      logInfo(":sparkles: Before we move forward, let's clear up your calendar")
    )
      .chain(() => getEvents(when))
      .chain(({ items }) => {
        const eventsCreated = items.filter(event => event.creator.self);
        const eventsInvited = items.filter(event => event.attendees);
        return sequenceT(taskEitherSeq)(
          manageEventsCreated(eventsCreated),
          manageEventsInvited(eventsInvited)
        );
      })
      .map(constVoid).value;
}

function createEventOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  return ({ when, where }) => {
    const logSuccess = (events: calendar_v3.Schema$Event) =>
      sequenceT(taskEitherSeq)(
        logInfo(
          "\n:white_check_mark: Created event on your calendar. Click here to see it:\n"
        ),
        logDetail(events.htmlLink + "\n")
      );

    return fluent(taskEither)(createEvent(when, `Ferie ${where}`))
      .chain(logSuccess)
      .map(constVoid).value;
  };
}

type Context = {
  when: Interval;
  where: string;
};

function addOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  const ops = sequenceT(readerTaskEitherSeq)(
    () => logInfo("\n:calendar: Adding your vacation to Google Calendar...\n"),
    manageExistingEvents(),
    createEventOnCalendar()
  );
  return readerTaskEither.map(ops, constVoid);
}

function addOnTeamweek(): ReaderTaskEither<Context, unknown, void> {
  logInfo("\n:hourglass: Adding your vacation to Teamweek...\n");
  return ({ when, where }) => addTask(where, when);
}

declare function addOnSlack(): ReaderTaskEither<Context, unknown, void>;
