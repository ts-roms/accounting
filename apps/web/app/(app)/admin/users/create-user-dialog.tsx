'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import { createUserSchema, type CreateUserInput } from '@accounting/validation';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useCreateUser, useRoles } from '@/lib/api/hooks';

type UserFormInput = z.input<typeof createUserSchema>;

export function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const roles = useRoles();
  const createUser = useCreateUser();
  const form = useForm<UserFormInput, unknown, CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { email: '', firstName: '', lastName: '', password: '', roleIds: [] },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const user = await createUser.mutateAsync(values);
      toast.success(`User ${user.email} created.`);
      form.reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && form.formState.isDirty && !window.confirm('Discard unsaved changes?')) return;
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            The user receives the selected roles organization-wide. Company-specific roles can be
            added afterwards.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2" noValidate>
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>First name</FormLabel>
                  <FormControl>
                    <Input autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="lastName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Last name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Initial password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormDescription>At least 10 characters, mixed case and a digit.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="roleIds"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Roles</FormLabel>
                  <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                    {(roles.data ?? []).map((role) => {
                      const current = field.value ?? [];
                      const checked = current.includes(role.id);
                      return (
                        <div key={role.id} className="flex items-start gap-2">
                          <Checkbox
                            id={`role-${role.id}`}
                            checked={checked}
                            onCheckedChange={(v) =>
                              field.onChange(
                                v ? [...current, role.id] : current.filter((id) => id !== role.id),
                              )
                            }
                          />
                          <Label
                            htmlFor={`role-${role.id}`}
                            className="cursor-pointer leading-tight"
                          >
                            {role.name}
                            <span className="block text-xs font-normal text-muted-foreground">
                              {role.description}
                            </span>
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="md:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                Create user
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
