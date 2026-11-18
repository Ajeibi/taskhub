import { expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'e2e-password-123'; // throw-away test accounts on a local/test stack only

export interface Account { name: string; email: string; page: Page }

const uid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Registers a brand-new user through the real UI and lands on Home. Each account lives in its own browser context. */
export async function signUp(browser: Browser, label = 'Tester'): Promise<Account> {
  const id = uid();
  const name = `${label} ${id}`;
  const email = `${label.toLowerCase()}.${id}@e2e.test`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(label);
  return { name, email, page };
}

export async function createProject(page: Page, name: string): Promise<string> {
  await page.getByRole('link', { name: 'All projects' }).click();
  await page.getByRole('button', { name: '+ New project' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return page.url();
}

/** Creates a task through the "+ Add task" dialog. */
export async function addTask(page: Page, title: string, assignee?: string): Promise<void> {
  await page.getByRole('button', { name: '+ Add task' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Task name').fill(title);
  if (assignee) await dialog.getByLabel('Assignee').selectOption({ label: assignee });
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(dialog).toBeHidden();
}

/** A status section of the List view / a column of the Board (both are labelled regions). */
export const group = (page: Page, status: string) => page.getByRole('region', { name: status, exact: true });
