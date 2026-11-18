import { expect, test } from '@playwright/test';
import { addTask, createProject, group, PASSWORD, signUp } from './helpers';

test.describe('authentication', () => {
  test('signs up, lands on Home, and keeps the session across a reload', async ({ browser }) => {
    const { page } = await signUp(browser, 'Ada');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada'); // restored from the httpOnly refresh cookie
    await expect(page.getByRole('link', { name: 'My tasks' })).toBeVisible();
  });

  test('shows an error for a wrong password and stays on the sign-in form', async ({ browser }) => {
    const { email, page } = await signUp(browser, 'Grace');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid email or password');
    // ...and the right password works
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Grace');
  });

  test('redirects an anonymous visitor to the sign-in page', async ({ page }) => {
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('projects and tasks', () => {
  test('creates a project and a task, moves it through statuses, comments and edits the comment', async ({ browser }) => {
    const { page, name } = await signUp(browser, 'Ivy');
    await createProject(page, 'Launch plan');
    await expect(page.getByRole('link', { name: 'Launch plan' }).first()).toBeVisible(); // appears in the sidebar too

    await addTask(page, 'Draft announcement');
    const todo = group(page, 'To do');
    await expect(todo.getByRole('button', { name: 'Draft announcement', exact: true })).toBeVisible();

    // Open the slide-over and change the status: it auto-saves and the row moves group.
    await todo.getByRole('button', { name: 'Draft announcement', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Task details' });
    await panel.getByLabel('Status').selectOption('in_progress');
    await panel.getByLabel('Assignee').selectOption({ label: `${name} (me)` });
    await panel.getByLabel('Priority').selectOption('urgent');

    await panel.getByLabel('New comment').fill('First draft is ready');
    await panel.getByRole('button', { name: 'Comment' }).click();
    await expect(panel.getByText('First draft is ready')).toBeVisible();
    await panel.getByRole('button', { name: 'Edit' }).click();
    await panel.getByLabel('Edit comment').fill('Second draft is ready');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel.getByText('Second draft is ready')).toBeVisible();
    await expect(panel.getByText('(edited)')).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0); // three quick edits, no false conflict

    await page.keyboard.press('Escape');
    await expect(group(page, 'In progress').getByRole('button', { name: 'Draft announcement', exact: true })).toBeVisible();
    await expect(todo.getByRole('button', { name: 'Draft announcement', exact: true })).toHaveCount(0);

    // Persisted: a reload shows the same state.
    await page.reload();
    await expect(group(page, 'In progress').getByRole('button', { name: 'Draft announcement', exact: true })).toBeVisible();

    // Completing it from the status icon moves it to Done.
    await page.getByRole('button', { name: 'Mark Draft announcement done' }).click();
    await expect(group(page, 'Done').getByRole('button', { name: 'Draft announcement', exact: true })).toBeVisible();
  });

  test('quick-add creates a task directly in the chosen status', async ({ browser }) => {
    const { page } = await signUp(browser, 'Quinn');
    await createProject(page, 'Quick add');
    const review = group(page, 'In review');
    await review.getByRole('button', { name: '+ Add task' }).click();
    await review.getByLabel('New In review task').fill('Check contracts');
    await review.getByLabel('New In review task').press('Enter');
    await expect(review.getByRole('button', { name: 'Check contracts', exact: true })).toBeVisible();
  });

  test('board: dragging a card to another column changes its status', async ({ browser }) => {
    const { page } = await signUp(browser, 'Bea');
    await createProject(page, 'Board test');
    await addTask(page, 'Ship the beta');
    await page.getByRole('tab', { name: 'Board' }).click();
    const card = group(page, 'To do').getByRole('article').filter({ hasText: 'Ship the beta' });
    await card.dragTo(group(page, 'In progress'));
    await expect(group(page, 'In progress').getByText('Ship the beta')).toBeVisible();
    await expect(group(page, 'To do').getByText('Ship the beta')).toHaveCount(0);
  });

  test('search and filters narrow the list', async ({ browser }) => {
    const { page } = await signUp(browser, 'Finn');
    await createProject(page, 'Filtering');
    await addTask(page, 'Fix billing bug');
    await addTask(page, 'Write onboarding docs');
    await page.getByRole('searchbox', { name: 'Search tasks' }).fill('billing');
    await expect(page.getByRole('button', { name: 'Fix billing bug', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Write onboarding docs', exact: true })).toHaveCount(0);
  });
});

test.describe('collaboration and access control', () => {
  test('an owner adds a teammate who assigns work back; outsiders cannot see the project', async ({ browser }) => {
    const owner = await signUp(browser, 'Olive');
    const projectUrl = await createProject(owner.page, 'Shared project');

    const member = await signUp(browser, 'Milo');
    const outsider = await signUp(browser, 'Otto');

    // Before being added, the teammate cannot open the project: indistinguishable from "does not exist".
    await member.page.goto(projectUrl);
    await expect(member.page.getByRole('heading', { name: 'Project not found' })).toBeVisible();

    // The owner adds them from the Overview tab.
    await owner.page.getByRole('tab', { name: 'Overview' }).click();
    await owner.page.getByLabel('Find people to add').fill(member.email);
    await owner.page.getByRole('button', { name: new RegExp(member.name) }).click();
    await expect(owner.page.getByRole('region', { name: 'Team' })).toContainText(member.name);

    // Now the teammate can open it, create a task and assign it to the owner.
    await member.page.goto(projectUrl);
    await expect(member.page.getByRole('heading', { level: 1, name: 'Shared project' })).toBeVisible();
    await addTask(member.page, 'Review the budget', owner.name);

    // The owner sees it in "My tasks".
    await owner.page.getByRole('link', { name: 'My tasks' }).click();
    await expect(owner.page.getByRole('button', { name: 'Review the budget', exact: true })).toBeVisible();

    // A third user who was never added still sees nothing.
    await outsider.page.goto(projectUrl);
    await expect(outsider.page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
  });
});
