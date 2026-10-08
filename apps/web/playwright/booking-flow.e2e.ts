import { BookingStatus } from "@calcom/prisma/enums";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

import { test } from "./lib/fixtures";
import { submitAndWaitForResponse } from "./lib/testUtils";

test.describe.configure({ mode: "parallel" });

test.afterEach(async ({ users }) => {
  await users.deleteAll();
});

async function selectFirstAvailableSlot(page: Page): Promise<void> {
  await page.getByTestId("incrementMonth").click();
  await page.locator('[data-testid="day"][data-disabled="false"]').first().click();
  const firstSlot = page.locator('[data-testid="time"]').first();
  await expect(firstSlot).toBeVisible();
  await firstSlot.click();
}

async function fillAttendeeDetails(
  page: Page,
  attendee: { name: string; email: string; notes?: string }
): Promise<void> {
  await page.fill('[name="name"]', attendee.name);
  await page.fill('[name="email"]', attendee.email);
  if (attendee.notes) {
    await page.fill('[name="notes"]', attendee.notes);
  }
}

test("public booking: books a 30 min event from the user's public page", async ({ page, users, prisma }) => {
  const organizer = await users.create({ name: "Booking Flow Organizer" });
  const attendee = {
    name: "Jane Attendee",
    email: users.trackEmail({ username: "jane-attendee", domain: "example.com" }),
    notes: "Looking forward to our call",
  };

  await page.goto(`/${organizer.username}`);
  await expect(page.getByTestId("event-types")).toBeVisible();

  await page.locator('[data-testid="event-type-link"]', { hasText: "30 min" }).first().click();
  await page.waitForURL((url) => url.pathname === `/${organizer.username}/30-min`);

  await selectFirstAvailableSlot(page);

  await expect(page.locator('[name="name"]')).toBeVisible();
  await fillAttendeeDetails(page, attendee);

  await submitAndWaitForResponse(page, "/api/book/event", {
    action: () => page.getByTestId("confirm-book-button").click(),
  });

  await page.waitForURL((url) => url.pathname.startsWith("/booking/"));
  await expect(page.getByTestId("success-page")).toBeVisible();
  await expect(page.locator("#modal-headline")).toHaveText("This meeting is scheduled");
  await expect(page.getByTestId("booking-title")).toContainText("30 min");
  await expect(page.getByTestId(`attendee-name-${attendee.name}`)).toBeVisible();
  await expect(page.getByTestId(`attendee-email-${attendee.email}`)).toBeVisible();
  await expect(page.getByText(attendee.notes)).toBeVisible();

  const bookingUid = new URL(page.url()).pathname.split("/").pop();
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { uid: bookingUid },
    select: { status: true, userId: true, attendees: { select: { name: true, email: true } } },
  });
  expect(booking.status).toBe(BookingStatus.ACCEPTED);
  expect(booking.userId).toBe(organizer.id);
  expect(booking.attendees).toEqual([{ name: attendee.name, email: attendee.email }]);
});

test("public booking: requires attendee details before confirming", async ({ page, users }) => {
  const organizer = await users.create();

  await page.goto(`/${organizer.username}/30-min`);
  await selectFirstAvailableSlot(page);

  await page.getByTestId("confirm-book-button").click();
  await expect(page.locator('[name="name"]:invalid, [name="name"][aria-invalid="true"]')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/${organizer.username}/30-min`));

  await fillAttendeeDetails(page, {
    name: "Validation Attendee",
    email: users.trackEmail({ username: "validation-attendee", domain: "example.com" }),
  });
  await submitAndWaitForResponse(page, "/api/book/event", {
    action: () => page.getByTestId("confirm-book-button").click(),
  });
  await expect(page.getByTestId("success-page")).toBeVisible();
});

test("public booking: shows a pending state for events that require confirmation", async ({
  page,
  users,
  prisma,
}) => {
  const organizer = await users.create();
  const attendeeEmail = users.trackEmail({ username: "optin-attendee", domain: "example.com" });

  await page.goto(`/${organizer.username}/opt-in`);
  await selectFirstAvailableSlot(page);
  await fillAttendeeDetails(page, { name: "Opt-in Attendee", email: attendeeEmail });

  await submitAndWaitForResponse(page, "/api/book/event", {
    action: () => page.getByTestId("confirm-book-button").click(),
  });

  await expect(page.getByTestId("success-page")).toBeVisible();
  await expect(page.locator("#modal-headline")).toHaveText("Your booking has been submitted");

  const bookingUid = new URL(page.url()).pathname.split("/").pop();
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { uid: bookingUid },
    select: { status: true },
  });
  expect(booking.status).toBe(BookingStatus.PENDING);
});

test("public booking: a booked slot is no longer offered", async ({ page, users }) => {
  const organizer = await users.create();

  await page.goto(`/${organizer.username}/30-min`);
  await page.getByTestId("incrementMonth").click();
  await page.locator('[data-testid="day"][data-disabled="false"]').first().click();
  const firstSlot = page.locator('[data-testid="time"]').first();
  await expect(firstSlot).toBeVisible();
  const bookedTime = await firstSlot.getAttribute("data-time");
  expect(bookedTime).toBeTruthy();
  await firstSlot.click();

  const dayUrl = new URL(page.url());
  dayUrl.searchParams.delete("slot");

  await fillAttendeeDetails(page, {
    name: "First Attendee",
    email: users.trackEmail({ username: "first-attendee", domain: "example.com" }),
  });
  await submitAndWaitForResponse(page, "/api/book/event", {
    action: () => page.getByTestId("confirm-book-button").click(),
  });
  await expect(page.getByTestId("success-page")).toBeVisible();

  await page.goto(dayUrl.toString());
  await expect(page.locator('[data-testid="time"]').first()).toBeVisible();
  await expect(page.locator(`[data-testid="time"][data-time="${bookedTime}"]`)).toHaveCount(0);
});
