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
import { Do } from "fp-ts-contrib/lib/Do";

registerPrompt("datetime", require("inquirer-datepicker-prompt"));

export const command = "add";
export const desc = "Add a new vacation";
export const builder: { [key: string]: yargs.Options } = {};

export function handler(): Promise<unknown> {
  logInfo(":palm_tree: Getting a break? Great!\n");
  const task = Do(taskEither)
    .bind("where", askWhere())
    .bind("when", askWhen())
    .doL(({ where, when }) => {
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
    })
    .done();
  return mapLeft(task, logError)().catch(logError);
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
  const fromAnswers = askPrompt<{ when_from: Date }>([
    {
      type: "datetime",
      name: "when_from",
      message: "From when?",
      date: {
        min: format(Date.now(), "M/D/YYYY")
      },
      format: ["dd", "/", "mm", "/", "yyyy"]
    } as any
  ]);
  const from = taskEither.map(fromAnswers, a => a.when_from);

  return Do(taskEither)
    .bind("fromDate", from)
    .bindL("a", ({ fromDate }) =>
      askPrompt<{ when_to: Date }>([
        {
          type: "datetime",
          name: "when_to",
          message: "To when?",
          initial: fromDate,
          format: ["dd", "/", "mm", "/", "yyyy"]
        } as any
      ])
    )
    .return(({ fromDate, a }) => ({ from: fromDate, to: a.when_to }));
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
    Do(taskEither)
      .bind(
        "response",
        askPrompt<{ eventsToDecline: Array<calendar_v3.Schema$Event> }>([
          {
            type: "checkbox",
            name: "eventsToDecline",
            message: "Choose the ones you want to decline:",
            choices: eventsToChoices(eventsInvited, true)
          }
        ])
      )
      .return(({ response }) =>
        array.traverse(taskEither)(response.eventsToDecline, declineEvent)
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
    Do(taskEither)
      .bind(
        "response",
        askPrompt<{ eventsToDelete: Array<calendar_v3.Schema$Event> }>([
          {
            type: "checkbox",
            name: "eventsToDelete",
            message: "Choose the ones you want to delete:",
            choices: eventsToChoices(nonRecurrentEvensts, false)
          }
        ])
      )
      .return(({ response }) =>
        array.traverse(taskEither)(response.eventsToDelete, deleteEvent)
      );
  }
}

function manageExistingEvents(): ReaderTaskEither<Context, unknown, unknown> {
  logInfo(":sparkles: Before we move forward, let's clear up your calendar");
  return ({ when }) =>
    Do(taskEither)
      .bind("response", getEvents(when))
      .doL(({ response }) => {
        const eventsCreated = response.items.filter(
          event => event.creator.self
        );
        return manageEventsCreated(eventsCreated);
      })
      .doL(({ response }) => {
        const eventsInvited = response.items.filter(event => event.attendees);
        return manageEventsInvited(eventsInvited);
      })
      .done();
}

function createEventOnCalendar(): ReaderTaskEither<Context, unknown, void> {
  return ({ when, where }) =>
    Do(taskEither)
      .bind("events", createEvent(when, `Ferie ${where}`))
      .return(({ events }) => {
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
