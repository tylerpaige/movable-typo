/** Opens the system file picker for one image and returns it as base64. */
export function pickImageFile(): Promise<{ data: string; mime: string; ext: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.style.display = "none";
    document.body.append(input);
    const done = (v: Awaited<ReturnType<typeof pickImageFile>>) => {
      input.remove();
      resolve(v);
    };
    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      const reader = new FileReader();
      reader.onload = () => {
        const [head, data] = String(reader.result).split(",");
        const mime = /data:([^;]+)/.exec(head)?.[1] ?? file.type;
        const ext = { "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[mime] ?? "jpeg";
        done({ data, mime, ext });
      };
      reader.onerror = () => done(null);
      reader.readAsDataURL(file);
    });
    input.click();
  });
}
