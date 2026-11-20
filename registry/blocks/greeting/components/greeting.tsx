/** Shows a greeting, such as the `message` from your app's `GET /api/hello`. */
export function Greeting({ message }: Readonly<{ message: string }>) {
  return <p className="text-sm text-muted-foreground">{message}</p>
}
