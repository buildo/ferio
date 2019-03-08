import { logInfo, logDetail, logError } from '../utils';
import {
  prompt,
  Questions,
  Answers,
  registerPrompt,
  ChoiceType
} from 'inquirer';
import { TaskEither, tryCatch, taskEither } from 'fp-ts/lib/TaskEither';
import * as yargs from 'yargs';
import { createEvent, getEvents, declineEvent, deleteEvent } from '../gcal';
import { constVoid } from 'fp-ts/lib/function';
import { array } from 'fp-ts/lib/Array';
import { calendar_v3 } from 'googleapis';
import { format } from 'date-fns';

registerPrompt('datetime', require('inquirer-datepicker-prompt'));

export interface Interval {
  from: Date;
  to: Date;
}

function ask(questions: Questions): TaskEither<unknown, Answers> {
  return tryCatch(() => prompt(questions), reason => reason);
}

function askWhere(): TaskEither<unknown, string> {
  return ask([
    {
      type: 'input',
      name: 'where',
      message: 'Where are you going?'
    }
  ]).map(a => a.where);
}

function askWhen(): TaskEither<unknown, Interval> {
  const from = ask([
    {
      type: 'datetime',
      name: 'when_from',
      message: 'From when?',
      date: {
        min: format(Date.now(), 'M/D/YYYY')
      },
      format: ['dd', '/', 'mm', '/', 'yyyy']
    } as any
  ]).map(a => a.when_from);

  return from.chain(
    fromDate => (
      console.log(fromDate),
      ask([
        {
          type: 'datetime',
          name: 'when_to',
          message: 'To when?',
          initial: fromDate,
          format: ['dd', '/', 'mm', '/', 'yyyy']
        } as any
      ])
        .map(a => a.when_to)
        .map(toDate => ({
          from: fromDate,
          to: toDate
        }))
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
      'ddd DD MMM'
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
    return ask([
      {
        type: 'checkbox',
        name: 'eventsToDecline',
        message:
          "These are the events you're invited to during your vacation. Choose the ones you want to decline:",
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
  if (eventsCreated.length === 0) {
    return taskEither.of(null);
  } else {
    return ask([
      {
        type: 'checkbox',
        name: 'eventsToDelete',
        message:
          'These are the events created by you that are scheduled during your vacation. Choose the ones you want to delete:',
        choices: eventsToChoices(eventsCreated, false)
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

function manageExistingEvents(when: Interval): TaskEither<unknown, unknown> {
  return getEvents(when).chain(response => {
    const eventsInvited = response.items.filter(event => event.attendees);
    const eventsCreated = response.items.filter(event => event.creator.self);
    return manageEventsCreated(eventsCreated).chainSecond(
      manageEventsInvited(eventsInvited)
    );
  });
}

function createEventOnCalendar(
  when: Interval,
  where: string
): TaskEither<unknown, void> {
  return createEvent(when, `Ferie ${where}`).map(events => {
    logInfo(
      '\n:white_check_mark: Created event on your calendar. Click here to see it:\n'
    );
    logDetail(events.htmlLink);
    logDetail('\n');
  });
}

function addOnCalendar(
  when: Interval,
  where: string
): TaskEither<unknown, void> {
  return manageExistingEvents(when).chainSecond(
    createEventOnCalendar(when, where)
  );
}
declare function addOnTeamweek(where: string): TaskEither<unknown, void>;
declare function addOnSlack(where: string): TaskEither<unknown, void>;

export type Params = { where?: string };
export const command = 'add';
export const desc = 'Add a new vacation';
export const builder: { [key: string]: yargs.Options } = {};

export function handler(): Promise<unknown> {
  logInfo(':palm_tree: Getting a break? Great!\n');
  return askWhere()
    .chain(where =>
      askWhen().chain(when => {
        logInfo(
          `:ok_hand: ${where} from ${format(when.from, 'DD/MM/YY')} to ${format(
            when.to,
            'DD/MM/YY'
          )}, got it!`
        );
        logInfo('\n:calendar: Adding your vacation to Google Calendar...\n');
        return addOnCalendar(when, where);
        // .chainSecond(addOnTeamweek(where))
        // .chainSecond(addOnSlack(where));
      })
    )
    .mapLeft(logError)
    .run()
    .catch(logError);
}
